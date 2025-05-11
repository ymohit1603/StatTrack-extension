import * as adm_zip from 'adm-zip';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as request from 'request';
import * as semver from 'semver';
import * as which from 'which';

import { Options, Setting } from './options';

import { Desktop } from './desktop';
import { Logger } from './logger';

enum osName {
  darwin = 'darwin',
  windows = 'windows',
  linux = 'linux',
}

export class Dependencies {
  private options: Options;
  private logger: Logger;
  private resourcesLocation: string;
  private cliLocation?: string = undefined;
  private cliLocationGlobal?: string = undefined;
  private cliInstalled: boolean = false;
  // private githubDownloadUrl = 'https://github.com/ymohit1603/StatTrack-cli/releases/download/v1.0.0/';
  

  private githubReleasesUrl = 'https://api.github.com/repos/ymohit1603/StatTrack-cli/releases';
  private legacyOperatingSystems: {
    [key in osName]?: {
      kernelLessThan: string;
      tag: string;
    }[];
  } = {
    [osName.darwin]: [{ kernelLessThan: '17.0.0', tag: 'v1.39.1-alpha.1' }],
  };

  constructor(options: Options, logger: Logger, resourcesLocation: string) {
    this.options = options;
    this.logger = logger;
    this.resourcesLocation = resourcesLocation;
    console.log(`Initializing StatTrack with resources location: ${resourcesLocation}`);
    
    // Ensure resources directory exists
    if (!fs.existsSync(this.resourcesLocation)) {
      console.log(`Creating resources directory: ${this.resourcesLocation}`);
      fs.mkdirSync(this.resourcesLocation, { recursive: true });
    }
  }

  public getCliLocation(): string {
    if (this.cliLocation) {
      console.log(`Using cached CLI location: ${this.cliLocation}`);
      return this.cliLocation;
    }

    this.cliLocation = this.getCliLocationGlobal();
    if (this.cliLocation) {
      console.log(`Using global CLI location: ${this.cliLocation}`);
      return this.cliLocation;
    }

    const osname = this.osName();
    const arch = this.architecture();
    const ext = Desktop.isWindows() ? '.exe' : '';
    const binary = `stattrack-${osname}-${arch}${ext}`;
    this.cliLocation = path.join(this.resourcesLocation, binary);
    console.log(`Using local CLI location: ${this.cliLocation}`);
    return this.cliLocation;
  }

  public getCliLocationGlobal(): string | undefined {
    console.log("global",this.cliLocationGlobal);
    if (this.cliLocationGlobal) return this.cliLocationGlobal;

    const binaryName = `stattrack${Desktop.isWindows() ? '.exe' : ''}`;
    const path = which.sync(binaryName, { nothrow: true });
    console.log("path",path);
    if (path) {
      this.cliLocationGlobal = path;
      console.log(`Using global stattrack location: ${path}`);
    }

    return this.cliLocationGlobal;
  }

  public checkAndInstallCli(callback: () => void): void {
    console.log('Checking if StatTrack CLI is installed...');
    
    if (this.isCliInstalled()) {
      console.log('StatTrack CLI is already installed, checking if it needs updates...');
      this.isCliLatest((isLatest) => {
        if (!isLatest) {
          console.log('Update available for StatTrack CLI, installing...');
          this.installCli(callback);
        } else {
          console.log('StatTrack CLI is up to date, no need to download.');
          callback();
        }
      });
    } else {
      console.log('StatTrack CLI not found, installing...');
      this.installCli(callback);
    }
  }

  public isCliInstalled(): boolean {
    if (this.cliInstalled) {
      console.log('CLI is already installed (cached state)');
      return true;
    }
    
    const cliPath = this.getCliLocation();
    console.log(`Checking for CLI at: ${cliPath}`);
    
    if (fs.existsSync(cliPath)) {
      console.log(`CLI found at: ${cliPath}`);
      // Verify the CLI is executable
      try {
        fs.accessSync(cliPath, fs.constants.X_OK);
        console.log('CLI is executable');
        this.cliInstalled = true;
        return true;
      } catch (e: any) {
        console.log(`CLI exists but is not executable: ${cliPath}`);
        console.log(`Error: ${e.toString()}`);
        this.cliInstalled = false;
        return false;
      }
    } else {
      console.log(`CLI not found at: ${cliPath}`);
      this.cliInstalled = false;
      return false;
    }
  }

  private isCliLatest(callback: (arg0: boolean) => void): void {
    if (this.getCliLocationGlobal()) {
      callback(true);
      return;
    }

    let args = ['--version'];
    const options = Desktop.buildOptions();
    try {
      child_process.execFile(this.getCliLocation(), args, options, (error, _stdout, stderr) => {
        if (!(error != null)) {
          let currentVersion = _stdout.toString().trim() + stderr.toString().trim();
          console.log(`Current stattrack version is ${currentVersion}`);

          if (currentVersion === '<local-build>') {
            callback(true);
            return;
          }

          const tag = this.legacyReleaseTag();
          if (tag && currentVersion !== tag) {
            callback(false);
            return;
          }

          this.options.getSetting(
            'internal',
            'cli_version_last_accessed',
            true,
            (accessed: Setting) => {
              const now = Math.round(Date.now() / 1000);
              const lastAccessed = parseInt(accessed.value);
              const fourHours = 4 * 3600;
              if (lastAccessed && lastAccessed + fourHours > now) {
                console.log(
                  `Skip checking for stattrack updates because recently checked ${
                    now - lastAccessed
                  } seconds ago.`,
                );
                callback(true);
                return;
              }

              console.log('Checking for updates to stattrack...');
              this.getLatestCliVersion((latestVersion) => {
                if (currentVersion === latestVersion) {
                  console.log('stattrack is up to date');
                  callback(true);
                } else if (latestVersion) {
                  console.log(`Found an updated stattrack ${latestVersion}`);
                  callback(false);
                } else {
                  console.log('Unable to find latest stattrack version');
                  callback(false);
                }
              });
            },
          );
        } else {
          callback(false);
        }
      });
    } catch (e) {
      callback(false);
    }
  }

  private getLatestCliVersion(callback: (arg0: string) => void): void {
    this.options.getSetting('settings', 'proxy', false, (proxy: Setting) => {
      this.options.getSetting('settings', 'no_ssl_verify', false, (noSSLVerify: Setting) => {
        let options = {
          url: this.githubReleasesUrl,
          json: true,
          headers: {
            'User-Agent': 'github.com/ymohit1603/vscode-stattrack',
          },
        };
        console.log(`Fetching latest stattrack version from GitHub API: ${options.url}`);
        if (proxy.value) {
          console.log(`Using Proxy: ${proxy.value}`);
          options['proxy'] = proxy.value;
        }
        if (noSSLVerify.value === 'true') options['strictSSL'] = false;
        try {
          request.get(options, (error: any, response, json) => {
            if (!error && response && response.statusCode == 200) {
              console.log(`GitHub API Response ${response.statusCode}`);
              const latestCliVersion = json['tag_name'];
              console.log(`Latest stattrack version from GitHub: ${latestCliVersion}`);
              this.options.setSetting(
                'internal',
                'cli_version_last_accessed',
                String(Math.round(Date.now() / 1000)),
                true,
              );
              callback(latestCliVersion);
            } else {
              if (response) {
                console.log(`GitHub API Response ${response.statusCode}: ${error}`);
              } else {
                console.log(`GitHub API Response Error: ${error}`);
              }
              callback('');
            }
          });
        } catch (e:any) {
          console.log(`Error in download process: ${e.toString()}`);
          callback('');
        }
      });
    });
  }

  private installCli(callback: () => void): void {
    console.log('Starting StatTrack CLI installation...');
    
    // Clean up any existing zip files first
    try {
      const files = fs.readdirSync(this.resourcesLocation);
      files.forEach(file => {
        if (file.startsWith('stattrack') && file.endsWith('.zip')) {
          const filePath = path.join(this.resourcesLocation, file);
          console.log(`Cleaning up old zip file: ${filePath}`);
          fs.unlinkSync(filePath);
        }
      });
    } catch (e: any) {
      console.log(`Error cleaning up old zip files: ${e.toString()}`);
    }
    
    const url = this.cliDownloadUrl();
    const zipFile = path.join(this.resourcesLocation, 'stattrack' + this.randStr() + '.zip');
    
    console.log(`Download URL: ${url}`);
    console.log(`Target zip file: ${zipFile}`);
    
    this.downloadFile(
      url,
      zipFile,
      () => {
        console.log('Download completed, starting extraction...');
        this.extractCli(zipFile, callback);
      },
      () => {
        console.log('Failed to download StatTrack CLI');
        // Clean up the zip file if download fails
        try {
          if (fs.existsSync(zipFile)) {
            fs.unlinkSync(zipFile);
            console.log(`Cleaned up failed download: ${zipFile}`);
          }
        } catch (e: any) {
          console.log(`Error cleaning up failed download: ${e.toString()}`);
        }
        callback();
      }
    );
  }

  private isSymlink(file: string): boolean {
    try {
      return fs.lstatSync(file).isSymbolicLink();
    } catch (_) {}
    return false;
  }

  private extractCli(zipFile: string, callback: () => void): void {
    console.log(`Extracting StatTrack CLI to "${this.resourcesLocation}"...`);
    
    this.backupCli();
    this.unzip(zipFile, this.resourcesLocation, (unzipped) => {
      if (!unzipped) {
        console.log('Failed to extract StatTrack CLI');
        this.restoreCli();
        callback();
        return;
      }

      if (!Desktop.isWindows()) {
        this.removeCli();
        const cli = this.getCliLocation();
        try {
          console.log('Setting executable permissions...');
          fs.chmodSync(cli, 0o755);
          console.log('Executable permissions set successfully');
        } catch (e: any) {
          console.log(`Failed to set executable permissions: ${e.toString()}`);
        }

        const ext = Desktop.isWindows() ? '.exe' : '';
        const link = path.join(this.resourcesLocation, `stattrack${ext}`);
        
        if (!this.isSymlink(link)) {
          try {
            console.log(`Creating symlink from stattrack to ${cli}`);
            fs.symlinkSync(cli, link);
            console.log('Symlink created successfully');
          } catch (e: any) {
            console.log(`Failed to create symlink: ${e.toString()}`);
            try {
              console.log('Attempting to copy file instead of symlink');
              fs.copyFileSync(cli, link);
              fs.chmodSync(link, 0o755);
              console.log('File copied successfully');
            } catch (e2: any) {
              console.log(`Failed to copy file: ${e2.toString()}`);
            }
          }
        }
      }

      try {
        console.log('Cleaning up zip file...');
        fs.unlinkSync(zipFile);
        console.log('Zip file removed successfully');
      } catch (e: any) {
        console.log(`Failed to remove zip file: ${e.toString()}`);
      }

      this.cliInstalled = true;
      console.log('StatTrack CLI installation completed successfully');
      callback();
    });
  }

  private backupCli() {
    if (fs.existsSync(this.getCliLocation())) {
      fs.renameSync(this.getCliLocation(), `${this.getCliLocation()}.backup`);
    }
  }

  private restoreCli() {
    const backup = `${this.getCliLocation()}.backup`;
    if (fs.existsSync(backup)) {
      fs.renameSync(backup, this.getCliLocation());
    }
  }

  private removeCli() {
    const backup = `${this.getCliLocation()}.backup`;
    if (fs.existsSync(backup)) {
      fs.unlinkSync(backup);
    }
  }

  private downloadFile(
    url: string,
    outputFile: string,
    callback: () => void,
    error: () => void,
  ): void {
    console.log(`Starting download from: ${url}`);
    this.options.getSetting('settings', 'proxy', false, (proxy: Setting) => {
      this.options.getSetting('settings', 'no_ssl_verify', false, (noSSLVerify: Setting) => {
        let options: any = { 
          url: url,
          timeout: 30000, // 30 second timeout
          headers: {
            'User-Agent': 'StatTrack-VSCode-Extension'
          }
        };
        if (proxy.value) {
          console.log(`Using Proxy: ${proxy.value}`);
          options['proxy'] = proxy.value;
        }
        if (noSSLVerify.value === 'true') options['strictSSL'] = false;

        try {
          console.log('Initiating download request...');
          const r = request.get(options);
          
          r.on('response', (response) => {
            console.log(response)
            console.log(`Response status: ${response.statusCode}`);
            console.log(`Response headers: ${JSON.stringify(response.headers)}`);
            
            const totalSize = parseInt(response.headers['content-length'] || '0', 10);
            let downloaded = 0;
            let lastProgressUpdate = Date.now();

            if (!isNaN(totalSize) && totalSize > 0) {
              console.log(`Total download size: ${totalSize} bytes`);

              r.on('data', (chunk) => {
                downloaded += chunk.length;
                const percent = ((downloaded / totalSize) * 100).toFixed(2);
                const progressBarLength = 20;
                const filledLength = Math.round((progressBarLength * downloaded) / totalSize);
                const progressBar = '█'.repeat(filledLength) + '░'.repeat(progressBarLength - filledLength);
                
                // Update progress every 500ms to avoid flooding the output
                const now = Date.now();
                if (now - lastProgressUpdate >= 500) {
                  console.log(`Downloading: [${progressBar}] ${percent}% (${downloaded}/${totalSize} bytes)`);
                  lastProgressUpdate = now;
                }
              });
            } else {
              console.log('Unable to determine file size (Content-Length missing)');
            }
          });

          r.on('error', (e: any) => {
            console.log(`Failed to download ${url}: ${e.toString()}`);
            console.log('Error details:', e);
            error();
          });

          const out = fs.createWriteStream(outputFile);
          r.pipe(out);

          r.on('end', () => {
            console.log('Download completed');
          });

          out.on('finish', () => {
            console.log(`File saved to: ${outputFile}`);
            callback();
          });

          out.on('error', (e: any) => {
            console.log(`Write stream error for ${outputFile}: ${e.toString()}`);
            console.log('Error details:', e);
            error();
          });
        } catch (e: any) {
          console.log(`Error in download process: ${e.toString()}`);
          console.log('Error details:', e);
          error();
        }
      });
    });
  }
  
  private unzip(file: string, outputDir: string, callback: (unzipped: boolean) => void): void {
    if (fs.existsSync(file)) {
      console.log(`ZIP file exists: ${file}`);
      try {
        let zip = new adm_zip(file);
        console.log(`Extracting to directory: ${outputDir}`);
        zip.extractAllTo(outputDir, true);
        
        // Check if the extraction was successful by listing the contents of the output directory
        const extractedFiles = fs.readdirSync(outputDir);
        console.log(`Extracted files: ${extractedFiles}`);
  
        // Remove the ZIP file after extraction
        fs.unlinkSync(file);
        console.log(`ZIP file removed: ${file}`);
        callback(true); // Indicating the unzip was successful
        return;
      } catch (e:any) {
        console.error(`Error extracting the ZIP file: ${e.message}`);
      }
  
      // If extraction failed, remove the file
      try {
        fs.unlinkSync(file);
        console.log(`Failed extraction - ZIP file removed: ${file}`);
      } catch (e2:any) {
        console.error(`Error removing the ZIP file: ${e2.message}`);
      }
      callback(false); // Indicating the unzip failed
    } else {
      console.error(`ZIP file not found: ${file}`);
      callback(false); // If the ZIP file doesn't exist
    }
  }
  

  private legacyReleaseTag() {
    const osname = this.osName() as osName;
    const legacyOS = this.legacyOperatingSystems[osname];
    if (!legacyOS) return;
    const version = legacyOS.find((spec) => {
      try {
        return semver.lt(os.release(), spec.kernelLessThan);
      } catch (e) {
        return false;
      }
    });
    return version?.tag;
  }

  private architecture(): string {
    const arch = os.arch();
    if (arch.indexOf('32') > -1) return '386';
    if (arch.indexOf('x64') > -1) return 'amd64';
    return arch;
  }

  private osName(): string {
    let osname = os.platform() as string;
    if (osname == 'win32') osname = 'windows';
    return osname;
  }

  private cliDownloadUrl(): string {
    const osname = this.osName();
    const arch = this.architecture();

    // Use legacy stattrack-cli release to support older operating systems
    const tag = this.legacyReleaseTag();
    if (tag) {
      return `https://github.com/ymohit1603/StatTrack-cli/releases/download/v1.0.0/stattrack-${osname}-${arch}.zip`;
    }

    const validCombinations = [
      'darwin-amd64',
      'darwin-arm64',
      'freebsd-386',
      'freebsd-amd64',
      'freebsd-arm',
      'linux-386',
      'linux-amd64',
      'linux-arm',
      'linux-arm64',
      'netbsd-386',
      'netbsd-amd64',
      'netbsd-arm',
      'openbsd-386',
      'openbsd-amd64',
      'openbsd-arm',
      'openbsd-arm64',
      'windows-386',
      'windows-amd64',
      'windows-arm64',
    ];
    console.log("osname",osname)
    if (!validCombinations.includes(`${osname}-${arch}`))
      this.reportMissingPlatformSupport(osname, arch);
    console.log("arch",arch)

    return `https://github.com/ymohit1603/StatTrack-cli/releases/download/v1.0.0/stattrack-${osname}-${arch}.zip`;
  }

  private reportMissingPlatformSupport(osname: string, architecture: string): void {
    const url = `https://api.stattrack.com/api/v1/cli-missing?osname=${osname}&architecture=${architecture}&plugin=vscode`;
    this.options.getSetting('settings', 'proxy', false, (proxy: Setting) => {
      this.options.getSetting('settings', 'no_ssl_verify', false, (noSSLVerify: Setting) => {
        let options = { url: url };
        if (proxy.value) options['proxy'] = proxy.value;
        if (noSSLVerify.value === 'true') options['strictSSL'] = false;
        try {
          request.get(options);
        } catch (e) {}
      });
    });
  }

  private randStr(): string {
    return (Math.random() + 1).toString(36).substring(7);
  }
}
  



