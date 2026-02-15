import fs from 'fs';
import path from 'path';

export interface PluginPathConfig {
  appRoot: string;
  configFilePath: string;
  pluginsDir: string;
  pluginStorageDir: string;
  installCacheDir: string;
}

interface PluginPathConfigFile {
  pluginsDir?: string;
  pluginStorageDir?: string;
  installCacheDir?: string;
}

export interface PluginPathStatus {
  path: string;
  exists: boolean;
  writable: boolean;
  error?: string;
}

export interface PluginPathSelfCheck {
  pluginsDir: PluginPathStatus;
  pluginStorageDir: PluginPathStatus;
  installCacheDir: PluginPathStatus;
}

function resolvePath(value: string, appRoot: string): string {
  return path.isAbsolute(value) ? value : path.resolve(appRoot, value);
}

function readConfigFile(configFilePath: string): PluginPathConfigFile {
  if (!fs.existsSync(configFilePath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(configFilePath, 'utf-8');
    const parsed = JSON.parse(raw) as PluginPathConfigFile;
    return parsed ?? {};
  } catch (error) {
    throw new Error(`[PluginConfig] Failed to parse config file ${configFilePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function resolvePluginPathConfig(): PluginPathConfig {
  const appRoot = path.resolve(process.env.APP_ROOT || process.cwd());
  const configFilePath = resolvePath(process.env.PLUGIN_CONFIG_FILE || 'config/plugins.json', appRoot);
  const fileConfig = readConfigFile(configFilePath);

  const pluginsDir = resolvePath(
    process.env.PLUGINS_DIR || fileConfig.pluginsDir || 'plugins',
    appRoot
  );

  const pluginStorageDir = resolvePath(
    process.env.PLUGIN_STORAGE_DIR || fileConfig.pluginStorageDir || path.join('data', '.plugin-storage'),
    appRoot
  );

  const installCacheDir = resolvePath(
    process.env.PLUGIN_INSTALL_CACHE_DIR || fileConfig.installCacheDir || path.join('data', '.plugin-install-cache'),
    appRoot
  );

  return {
    appRoot,
    configFilePath,
    pluginsDir,
    pluginStorageDir,
    installCacheDir
  };
}

function assertDirectoryWritable(directory: string, label: string) {
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    throw new Error(`[PluginConfig] ${label} could not be created at ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const probeFile = path.join(directory, `.wabi-write-test-${process.pid}-${Date.now()}`);

  try {
    fs.writeFileSync(probeFile, 'ok');
    fs.unlinkSync(probeFile);
  } catch (error) {
    throw new Error(`[PluginConfig] ${label} is not writable at ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validatePluginPathConfig(config: PluginPathConfig) {
  assertDirectoryWritable(config.pluginsDir, 'pluginsDir');
  assertDirectoryWritable(config.pluginStorageDir, 'pluginStorageDir');
  assertDirectoryWritable(config.installCacheDir, 'installCacheDir');
}

function getPathStatus(directory: string): PluginPathStatus {
  const exists = fs.existsSync(directory);
  const status: PluginPathStatus = {
    path: directory,
    exists,
    writable: false
  };

  if (!exists) {
    status.error = 'Directory does not exist';
    return status;
  }

  const probeFile = path.join(directory, `.wabi-write-test-${process.pid}-${Date.now()}`);

  try {
    fs.writeFileSync(probeFile, 'ok');
    fs.unlinkSync(probeFile);
    status.writable = true;
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
  }

  return status;
}

export function getPluginPathSelfCheck(config: PluginPathConfig): PluginPathSelfCheck {
  return {
    pluginsDir: getPathStatus(config.pluginsDir),
    pluginStorageDir: getPathStatus(config.pluginStorageDir),
    installCacheDir: getPathStatus(config.installCacheDir)
  };
}

export function logPluginPathStartupSummary(config: PluginPathConfig) {
  const selfCheck = getPluginPathSelfCheck(config);

  console.log('[PluginConfig] Startup path summary:');
  console.log(`  appRoot: ${config.appRoot}`);
  console.log(`  configFilePath: ${config.configFilePath}`);
  console.log(`  pluginsDir: ${selfCheck.pluginsDir.path} (exists=${selfCheck.pluginsDir.exists}, writable=${selfCheck.pluginsDir.writable})`);
  console.log(`  pluginStorageDir: ${selfCheck.pluginStorageDir.path} (exists=${selfCheck.pluginStorageDir.exists}, writable=${selfCheck.pluginStorageDir.writable})`);
  console.log(`  installCacheDir: ${selfCheck.installCacheDir.path} (exists=${selfCheck.installCacheDir.exists}, writable=${selfCheck.installCacheDir.writable})`);

  for (const [name, status] of Object.entries(selfCheck)) {
    if (status.error) {
      console.warn(`[PluginConfig] ${name} warning: ${status.error}`);
    }
  }
}
