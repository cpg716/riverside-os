import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const newVersion = process.argv[2];

if (!newVersion) {
  console.error('Usage: node scripts/bump-version.mjs <version>');
  process.exit(1);
}

// Strip 'v' prefix if present
const version = newVersion.startsWith('v') ? newVersion.substring(1) : newVersion;

console.log(`🚀 Bumping version to v${version}...`);

function replacePackageLockVersion(content) {
  const packageLock = JSON.parse(content);
  packageLock.version = version;
  if (packageLock.packages?.['']) {
    packageLock.packages[''].version = version;
  }
  return `${JSON.stringify(packageLock, null, 2)}\n`;
}

const filesToUpdate = [
  {
    path: 'package.json',
    replace: (content) => content.replace(/"version": ".*?"/, `"version": "${version}"`)
  },
  {
    path: 'package-lock.json',
    replace: replacePackageLockVersion
  },
  {
    path: 'client/package.json',
    replace: (content) => content.replace(/"version": ".*?"/, `"version": "${version}"`)
  },
  {
    path: 'client/package-lock.json',
    replace: replacePackageLockVersion
  },
  {
    path: 'server/Cargo.toml',
    replace: (content) => {
      // Only replace the first instance (package version) to avoid hitting dependency versions
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('version = "')) {
          lines[i] = `version = "${version}"`;
          break;
        }
      }
      return lines.join('\n');
    }
  },
  {
    path: 'client/src-tauri/tauri.conf.json',
    replace: (content) => content.replace(/"version": ".*?"/, `"version": "${version}"`)
  },
  {
    path: 'client/src-tauri/Cargo.toml',
    replace: (content) => {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('version = "')) {
          lines[i] = `version = "${version}"`;
          break;
        }
      }
      return lines.join('\n');
    }
  },
  {
    path: 'deployment/manager-app/package.json',
    replace: (content) => content.replace(/"version": ".*?"/, `"version": "${version}"`)
  },
  {
    path: 'deployment/manager-app/package-lock.json',
    replace: replacePackageLockVersion
  },
  {
    path: 'deployment/manager-app/src-tauri/tauri.conf.json',
    replace: (content) => content.replace(/"version": ".*?"/, `"version": "${version}"`)
  },
  {
    path: 'deployment/manager-app/src-tauri/Cargo.toml',
    replace: (content) => {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('version = "')) {
          lines[i] = `version = "${version}"`;
          break;
        }
      }
      return lines.join('\n');
    }
  },
  {
    path: 'deployment/counterpoint-bridge-gui/package.json',
    replace: (content) => content.replace(/"version": ".*?"/, `"version": "${version}"`)
  },
  {
    path: 'deployment/counterpoint-bridge-gui/package-lock.json',
    replace: replacePackageLockVersion
  },
  {
    path: 'deployment/counterpoint-bridge-gui/src-tauri/tauri.conf.json',
    replace: (content) => content.replace(/"version": ".*?"/, `"version": "${version}"`)
  },
  {
    path: 'deployment/counterpoint-bridge-gui/src-tauri/Cargo.toml',
    replace: (content) => {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('version = "')) {
          lines[i] = `version = "${version}"`;
          break;
        }
      }
      return lines.join('\n');
    }
  },
  {
    path: 'deployment/server-manager-app/package.json',
    replace: (content) => content.replace(/"version": ".*?"/, `"version": "${version}"`)
  },
  {
    path: 'deployment/server-manager-app/package-lock.json',
    replace: replacePackageLockVersion
  },
  {
    path: 'deployment/server-manager-app/src-tauri/tauri.conf.json',
    replace: (content) => content.replace(/"version": ".*?"/, `"version": "${version}"`)
  },
  {
    path: 'deployment/server-manager-app/src-tauri/Cargo.toml',
    replace: (content) => {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('version = "')) {
          lines[i] = `version = "${version}"`;
          break;
        }
      }
      return lines.join('\n');
    }
  },
  {
    path: 'ros-dev/package.json',
    replace: (content) => content.replace(/"version": ".*?"/, `"version": "${version}"`)
  },
  {
    path: 'ros-dev/package-lock.json',
    replace: replacePackageLockVersion
  },
  {
    path: 'ros-dev/src-tauri/tauri.conf.json',
    replace: (content) => content.replace(/"version": ".*?"/, `"version": "${version}"`)
  },
  {
    path: 'ros-dev/src-tauri/Cargo.toml',
    replace: (content) => {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('version = "')) {
          lines[i] = `version = "${version}"`;
          break;
        }
      }
      return lines.join('\n');
    }
  },
  {
    path: 'deployment/windows/riverside-deployment.config.example.json',
    replace: (content) => content.replace(/"releaseVersion": ".*?"/, `"releaseVersion": "${version}"`)
  },
  {
    path: 'README.md',
    replace: (content) => content
      .replace(/Version \d+\.\d+\.\d+ is the current release/, `Version ${version} is the current release`)
      .replace(/Current Version: \*\*v.*?\*\*/, `Current Version: **v${version}**`)
  }
];

filesToUpdate.forEach(file => {
  const fullPath = path.resolve(process.cwd(), file.path);
  if (fs.existsSync(fullPath)) {
    const content = fs.readFileSync(fullPath, 'utf8');
    const updatedContent = file.replace(content);
    fs.writeFileSync(fullPath, updatedContent, 'utf8');
    console.log(`✅ Updated ${file.path}`);
  } else {
    console.warn(`⚠️  Warning: ${file.path} not found, skipping.`);
  }
});

console.log(`\n🎉 Version bumped to v${version} successfully!`);
console.log('\nNext steps:');
console.log(`1. Update CHANGELOG.md for v${version}`);
console.log(`2. git add .`);
console.log(`3. git commit -m "chore: bump version to v${version}"`);
console.log(`4. git tag -a v${version} -m "Release v${version}"`);
console.log(`5. git push origin main && git push origin v${version}`);
