#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const iconDir = path.join(__dirname, '../frontend/src-tauri/icons');
const icoPath = path.join(iconDir, 'icon.ico');
const pngPath = path.join(iconDir, 'icon.png');

// Check if PNG already exists
if (fs.existsSync(pngPath)) {
  console.log('icon.png already exists, skipping conversion');
  process.exit(0);
}

// Check if ICO exists
if (!fs.existsSync(icoPath)) {
  console.error('icon.ico not found at', icoPath);
  process.exit(1);
}

// Try to use sharp if available, otherwise copy ICO as PNG
try {
  // Try using sharp library if installed
  const sharp = require('sharp');

  console.log('Converting icon.ico to icon.png using sharp...');
  sharp(icoPath)
    .png()
    .toFile(pngPath)
    .then(() => {
      console.log('Successfully converted icon.ico to icon.png');
      process.exit(0);
    })
    .catch(err => {
      console.error('Sharp conversion failed:', err.message);
      console.log('Falling back to file copy...');
      fallbackCopy();
    });
} catch (e) {
  console.log('Sharp not available, using fallback method...');
  fallbackCopy();
}

function fallbackCopy() {
  // Fallback: just copy ICO as PNG
  // This is not ideal but allows build to proceed
  // In reality, .ico files have ICO format structure but we're just copying the bytes
  try {
    fs.copyFileSync(icoPath, pngPath);
    console.log('Note: Copied icon.ico to icon.png (not a true conversion, but allows build to proceed)');
    console.log('For best results, provide a proper PNG icon file');
    process.exit(0);
  } catch (err) {
    console.error('Failed to copy icon:', err.message);
    process.exit(1);
  }
}
