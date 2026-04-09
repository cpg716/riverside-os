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

const filesToUpdate = [
  {
    path: 'package.json',
    replace: (content) => content.replace(/"version": ".*?"/, `"version": "${version}"`)
  },
  {
    path: 'client/package.json',
    replace: (content) => content.replace(/"version": ".*?"/, `"version": "${version}"`)
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
    path: 'README.md',
    replace: (content) => content.replace(/Current Version: \*\*v.*?\*\*/, `Current Version: **v${version}**`)
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
