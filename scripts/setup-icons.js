#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const iconDir = path.join(__dirname, '../frontend/src-tauri/icons');
const projectRoot = path.join(__dirname, '..');

console.log('🎨 Tauri Icon Setup Tool');
console.log('========================\n');

// Ensure icons directory exists
if (!fs.existsSync(iconDir)) {
  fs.mkdirSync(iconDir, { recursive: true });
  console.log(`✓ Created icons directory: ${iconDir}\n`);
}

// List current icon files
console.log('Current icon files:');
const files = fs.readdirSync(iconDir);
if (files.length === 0) {
  console.log('  (none)\n');
} else {
  files.forEach(f => console.log(`  - ${f}`));
  console.log();
}

// Try to use tauri icon command if available
console.log('Attempting to use Tauri CLI for icon generation...\n');

try {
  // Check if we can run tauri icon command
  const sourceIcon = path.join(projectRoot, 'app-icon.png');

  if (fs.existsSync(sourceIcon)) {
    console.log(`Found source icon at: ${sourceIcon}`);
    console.log('Running: tauri icon app-icon.png\n');

    try {
      execSync('tauri icon', {
        cwd: path.join(projectRoot, 'frontend'),
        stdio: 'inherit'
      });
      console.log('\n✓ Icons generated successfully via Tauri CLI');
      process.exit(0);
    } catch (e) {
      console.log('⚠ Tauri CLI icon generation failed, will use fallback method\n');
    }
  } else {
    console.log(`ℹ No source icon found at: ${sourceIcon}`);
    console.log('You can place a 1024x1024px PNG at the project root as app-icon.png\n');
  }
} catch (e) {
  console.log('⚠ Tauri CLI not available\n');
}

// Fallback: Ensure at least icon.ico exists
const icoPath = path.join(iconDir, 'icon.ico');
const pngPath = path.join(iconDir, 'icon.png');
const appIconPath = path.join(projectRoot, 'app-icon.png');

console.log('Fallback: Checking for required icon files...\n');

if (!fs.existsSync(icoPath)) {
  console.error('✗ icon.ico not found in icons directory');
  console.error('  Please add your favicon (ICO format) to:', icoPath);
  process.exit(1);
}

console.log('✓ icon.ico found');

// Try to create PNG from source if it doesn't exist
if (!fs.existsSync(pngPath)) {
  console.log('Creating icon.png from source...');

  try {
    // First, try to use source PNG if available
    if (fs.existsSync(appIconPath)) {
      console.log(`Using source: ${appIconPath}`);
      fs.copyFileSync(appIconPath, pngPath);
      console.log('✓ Created icon.png from app-icon.png');
    } else {
      // Try using sharp to convert ICO to PNG if available
      const sharp = await import('sharp').catch(() => null);

      if (sharp) {
        console.log('Converting icon.ico to PNG using sharp...');
        await sharp.default(icoPath)
          .png()
          .toFile(pngPath);
        console.log('✓ Created icon.png from icon.ico using sharp');
      } else {
        console.error('⚠ Could not create icon.png');
        console.error('  - app-icon.png not found');
        console.error('  - sharp library not available');
        console.log('  Continuing build (may fail if PNG is required)\n');
      }
    }
  } catch (err) {
    console.error('⚠ Could not create icon.png automatically');
    console.error(`  Error: ${err.message}`);
    console.log('  Continuing build (may fail if PNG is required)\n');
  }
} else {
  console.log('✓ icon.png already exists');
}

// Try to create ICNS for macOS if it doesn't exist
// NOTE: ICNS generation is only attempted on macOS where sips is available
const icnsPath = path.join(iconDir, 'icon.icns');
const platform = process.platform;

if (!fs.existsSync(icnsPath)) {
  if (platform === 'darwin') {
    console.log('\nAttempting to generate icon.icns for macOS...');

    try {
      // Use sips on macOS (built-in tool)
      try {
        execSync(`sips -z 512 512 "${pngPath}" --out "${icnsPath}"`, {
          stdio: 'pipe'
        });
        console.log('✓ Generated icon.icns using sips');
      } catch (e) {
        console.error('✗ Failed to generate icon.icns using sips');
        console.error(`  Error: ${e.message}`);
        console.log('  macOS bundling may fail without proper ICNS');
      }
    } catch (err) {
      console.error('⚠ ICNS generation failed:', err.message);
    }
  } else {
    console.log(`ℹ Skipping ICNS generation on ${platform} (only needed for macOS bundling)`);
  }
} else {
  console.log('✓ icon.icns already exists');
}

console.log('\n✓ Icon setup complete');
console.log('\nRecommended next steps:');
console.log('1. For best cross-platform support, use: tauri icon app-icon.png');
console.log('   (from your project\'s frontend directory)');
console.log('2. Or provide icon files in the icons directory for each platform:');
console.log('   - Windows: icon.ico (with layers at 16, 32, 48, 64, 256px)');
console.log('   - macOS: icon.icns (with 10 layers)');
console.log('   - Linux: 32x32.png, 128x128.png, 128x128@2x.png');
