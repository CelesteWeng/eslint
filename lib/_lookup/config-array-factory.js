"use strict";

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

const fs = require("fs");
const os = require("os");
const path = require("path");
const importFresh = require("import-fresh");
const { Minimatch } = require("minimatch");
const stripComments = require("strip-json-comments");
const { validateConfigSchema } = require("../config/config-validator");
const ConfigArrayElement = require("./config-array-element");
const ConfigArray = require("./config-array");
const ModuleResolver = require("./module-resolver");
const naming = require("./naming");
const debug = require("debug")("eslint:config-array-factory");

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

const eslintRecommendedPath = path.resolve(__dirname, "../../conf/eslint-recommended.js");
const eslintAllPath = path.resolve(__dirname, "../../conf/eslint-all.js");
const configFilenames = [
    ".eslintrc.js",
    ".eslintrc.yaml",
    ".eslintrc.yml",
    ".eslintrc.json",
    ".eslintrc",
    "package.json"
];
const minimatchOpts = { dot: true, matchBase: true };

/**
 * @typedef {Object} ConfigData
 * @property {Object} [env] The environment settings.
 * @property {string} [extends] The path to other config files or the package name of shareable configs.
 * @property {Object} [globals] The global variable settings.
 * @property {ConfigOverrideData[]} [overrides] The override settings per kind of files.
 * @property {string} [parser] The path to a parser or the package name of a parser.
 * @property {Object} [parserOptions] The parser options.
 * @property {string[]} [plugins] The plugin specifiers.
 * @property {string} [processor] The named pre/post processor specifier.
 * @property {boolean} [root] The root flag.
 * @property {Object} [rules] The rule settings.
 * @property {Object} [settings] The shared settings.
 */

/**
 * @typedef {Object} ConfigOverrideData
 * @property {Object} [env] The environment settings.
 * @property {string|string[]} [excludedFiles] The glob pattarns for excluded files.
 * @property {string} [extends] The path to other config files or the package name of shareable configs.
 * @property {string|string[]} files The glob pattarns for target files.
 * @property {Object} [globals] The global variable settings.
 * @property {ConfigOverrideData[]} [overrides] The override settings per kind of files.
 * @property {string} [parser] The path to a parser or the package name of a parser.
 * @property {Object} [parserOptions] The parser options.
 * @property {string[]} [plugins] The plugin specifiers.
 * @property {string} [processor] The named pre/post processor specifier.
 * @property {Object} [rules] The rule settings.
 * @property {Object} [settings] The shared settings.
 */

/**
 * Check if a given string is a file path.
 * @param {string} nameOrPath A module name or file path.
 * @returns {boolean} `true` if the `nameOrPath` is a file path.
 */
function isFilePath(nameOrPath) {
    return (
        /^\.{1,2}[/\\]/u.test(nameOrPath) ||
        path.isAbsolute(nameOrPath)
    );
}

/**
 * Normalize a given path.
 * @param {string} filePathOrName A path to a file to normalize.
 * @param {string} cwd The path to the current working directory.
 * @returns {string} Normalized path.
 * @private
 */
function normalizePath(filePathOrName, cwd) {
    const packageNameToTry =
        naming.normalizePackageName(filePathOrName, "eslint-config");

    try {
        return ModuleResolver.resolve(packageNameToTry, cwd);
    } catch (error) {
        if (!error || error.code !== "MODULE_NOT_FOUND") {
            throw error;
        }
    }

    return path.resolve(cwd, filePathOrName);
}

/**
 * Normalize a given pattern to an array.
 * @param {string|string[]|undefined} patterns A glob pattern or an array of glob patterns.
 * @returns {string[]|null} Normalized patterns.
 * @private
 */
function normalizePatterns(patterns) {
    if (Array.isArray(patterns) && patterns.length >= 1) {
        return patterns;
    }
    if (typeof patterns === "string") {
        return [patterns];
    }
    return null;
}

// eslint-disable-next-line valid-jsdoc
/**
 * Define `match` method to check if a relative path should be linted or not.
 * @param {string|string[]|undefined} files The glob patterns to include files.
 * @param {string|string[]|undefined} excludedFiles The glob patterns to exclude files.
 * @returns {((relativePath: string) => boolean)|null} The `match` method to check if a relative path should be linted or not.
 * @private
 */
function defineMatch(files, excludedFiles) {
    const includes = normalizePatterns(files);
    const excludes = normalizePatterns(excludedFiles);
    const positiveMatchers = includes && includes.map(pattern => new Minimatch(pattern, minimatchOpts));
    const negativeMatchers = excludes && excludes.map(pattern => new Minimatch(pattern, minimatchOpts));
    let retv = null;

    if (positiveMatchers && negativeMatchers) {
        retv = relativePath =>
            positiveMatchers.some(m => m.match(relativePath)) &&
            negativeMatchers.every(m => !m.match(relativePath));
    } else if (positiveMatchers) {
        retv = relativePath =>
            positiveMatchers.some(m => m.match(relativePath));
    } else if (negativeMatchers) {
        retv = relativePath =>
            negativeMatchers.every(m => !m.match(relativePath));
    }

    if (retv) {
        Object.defineProperties(retv, {

            // For debug.
            name: {
                configurable: true,
                value: JSON.stringify({ includes, excludes })
            },

            // `true` if the pattern doesn't limit file types.
            widely: {
                configurable: true,
                value: !includes || includes.some(pattern => pattern.endsWith("*"))
            }
        });
    }
    return retv;
}

// eslint-disable-next-line valid-jsdoc
/**
 * Combine two functions by logical and.
 * @param {(relativePath: string) => boolean} f A function to combine.
 * @param {(relativePath: string) => boolean} g Another function to combine.
 * @returns {(relativePath: string) => boolean} The combined function.
 * @private
 */
function defineAnd(f, g) {

    /**
     * Check if a given path is matched by both `f` and `g`.
     * @param {string} relativePath The relative path to a file to check.
     * @returns {boolean} `true` if the path is matched by both `f` and `g`.
     */
    function and(relativePath) {
        return f(relativePath) && g(relativePath);
    }

    Object.defineProperties(and, {

        // For debug.
        name: {
            configurable: true,
            value: `{"and":[${f.name},${g.name}]}`
        },

        // `true` if the pattern doesn't limit file types.
        widely: {
            configurable: true,
            value: Boolean(f.widely && g.widely)
        }
    });

    return and;
}

/**
 * Convenience wrapper for synchronously reading file contents.
 * @param {string} filePath The filename to read.
 * @returns {string} The file contents, with the BOM removed.
 * @private
 */
function readFile(filePath) {
    return fs.readFileSync(filePath, "utf8").replace(/^\ufeff/, "");
}

/**
 * Loads a YAML configuration from a file.
 * @param {string} filePath The filename to load.
 * @returns {ConfigData} The configuration object from the file.
 * @throws {Error} If the file cannot be read.
 * @private
 */
function loadYAMLConfigFile(filePath) {
    debug(`Loading YAML config file: ${filePath}`);

    // lazy load YAML to improve performance when not used
    const yaml = require("js-yaml");

    try {

        // empty YAML file can be null, so always use
        return yaml.safeLoad(readFile(filePath)) || {};
    } catch (e) {
        debug(`Error reading YAML file: ${filePath}`);
        e.message = `Cannot read config file: ${filePath}\nError: ${e.message}`;
        throw e;
    }
}

/**
 * Loads a JSON configuration from a file.
 * @param {string} filePath The filename to load.
 * @returns {ConfigData} The configuration object from the file.
 * @throws {Error} If the file cannot be read.
 * @private
 */
function loadJSONConfigFile(filePath) {
    debug(`Loading JSON config file: ${filePath}`);

    try {
        return JSON.parse(stripComments(readFile(filePath)));
    } catch (e) {
        debug(`Error reading JSON file: ${filePath}`);
        e.message = `Cannot read config file: ${filePath}\nError: ${e.message}`;
        e.messageTemplate = "failed-to-read-json";
        e.messageData = {
            path: filePath,
            message: e.message
        };
        throw e;
    }
}

/**
 * Loads a legacy (.eslintrc) configuration from a file.
 * @param {string} filePath The filename to load.
 * @returns {ConfigData} The configuration object from the file.
 * @throws {Error} If the file cannot be read.
 * @private
 */
function loadLegacyConfigFile(filePath) {
    debug(`Loading config file: ${filePath}`);

    // lazy load YAML to improve performance when not used
    const yaml = require("js-yaml");

    try {
        return yaml.safeLoad(stripComments(readFile(filePath))) || /* istanbul ignore next */ {};
    } catch (e) {
        debug(`Error reading YAML file: ${filePath}`);
        e.message = `Cannot read config file: ${filePath}\nError: ${e.message}`;
        throw e;
    }
}

/**
 * Loads a JavaScript configuration from a file.
 * @param {string} filePath The filename to load.
 * @returns {ConfigData} The configuration object from the file.
 * @throws {Error} If the file cannot be read.
 * @private
 */
function loadJSConfigFile(filePath) {
    debug(`Loading JS config file: ${filePath}`);
    try {
        return importFresh(filePath);
    } catch (e) {
        debug(`Error reading JavaScript file: ${filePath}`);
        e.message = `Cannot read config file: ${filePath}\nError: ${e.message}`;
        throw e;
    }
}

/**
 * Loads a configuration from a package.json file.
 * @param {string} filePath The filename to load.
 * @returns {ConfigData} The configuration object from the file.
 * @throws {Error} If the file cannot be read.
 * @private
 */
function loadPackageJSONConfigFile(filePath) {
    debug(`Loading package.json config file: ${filePath}`);
    try {
        return loadJSONConfigFile(filePath).eslintConfig || null;
    } catch (e) {
        debug(`Error reading package.json file: ${filePath}`);
        e.message = `Cannot read config file: ${filePath}\nError: ${e.message}`;
        throw e;
    }
}

/**
 * Creates an error to notify about a missing config to extend from.
 * @param {string} configName The name of the missing config.
 * @returns {Error} The error object to throw
 * @private
 */
function configMissingError(configName) {
    const error = new Error(`Failed to load config "${configName}" to extend from.`);

    error.messageTemplate = "extend-config-missing";
    error.messageData = {
        configName
    };
    return error;
}

/**
 * Loads a configuration file regardless of the source. Inspects the file path
 * to determine the correctly way to load the config file.
 * @param {string} filePath The path to the configuration.
 * @returns {ConfigData|null} The configuration information.
 * @private
 */
function loadConfigFile(filePath) {
    let config;

    switch (path.extname(filePath)) {
        case ".js":
            config = loadJSConfigFile(filePath);
            break;

        case ".json":
            if (path.basename(filePath) === "package.json") {
                config = loadPackageJSONConfigFile(filePath);
            } else {
                config = loadJSONConfigFile(filePath);
            }
            break;

        case ".yaml":
        case ".yml":
            config = loadYAMLConfigFile(filePath);
            break;

        default:
            config = loadLegacyConfigFile(filePath);
    }

    if (config) {
        validateConfigSchema(config, filePath);
    }

    return config;
}

/**
 * Concatenate two config data.
 * @param {IterableIterator<ConfigArrayElement>|null} elements The config elements.
 * @param {ConfigArray|null} parentConfigArray The parent config array.
 * @returns {ConfigArray} The concatenated config array.
 */
function createConfigArray(elements, parentConfigArray) {
    if (!elements) {
        return parentConfigArray || new ConfigArray();
    }
    const configArray = new ConfigArray(...elements);

    if (parentConfigArray && !configArray.isRoot()) {
        configArray.unshift(...parentConfigArray);
    }
    return configArray;
}

//------------------------------------------------------------------------------
// Public Interface
//------------------------------------------------------------------------------

/**
 * The factory of `ConfigArray` objects.
 *
 * This class provides methods to create `ConfigArray` instance.
 *
 * - `ConfigArrayFactory#create()`
 *     Create an instance from a config data. This is to handle CLIOptions.
 * - `ConfigArrayFactory#loadFile()`
 *     Create an instance from a config file. This is to handle `--config`
 *     option.
 * - `ConfigArrayFactory#loadOnDirectory()`
 *     Create an instance from a config file which is on a given directory. This
 *     tries to load `.eslintrc.*` or `package.json`. If not found, returns
 *     `null`.
 * - `ConfigArrayFactory#loadInAncestors()`
 *     Create an instance from config files which is in the ancestor directries
 *     of a given directory. This tries to load `.eslintrc.*` or `package.json`.
 *     If not found, returns `null`.
 */
class ConfigArrayFactory {

    /**
     * Initialize this instance.
     * @param {Object} [options] The map for additional plugins.
     * @param {Map<string,Parser>} [options.additionalParserPool] The map for additional parsers.
     * @param {Map<string,Plugin>} [options.additionalPluginPool] The map for additional plugins.
     * @param {string} [options.cwd] The path to the current working directory.
     */
    constructor({
        additionalParserPool = new Map(),
        additionalPluginPool = new Map(),
        cwd = process.cwd()
    } = {}) {

        /**
         * The map for additional parsers.
         * @type {Map<string,Parser>}
         * @private
         */
        this._additionalParserPool = additionalParserPool;

        /**
         * The map for additional plugins.
         * @type {Map<string,Plugin>}
         * @private
         */
        this._additionalPluginPool = additionalPluginPool;

        /**
         * The path to the current working directory.
         * @type {string}
         * @private
         */
        this._cwd = cwd;
    }

    /**
     * Create `ConfigArray` instance from a config data.
     * @param {ConfigData|null} configData The path to a directory.
     * @param {Object} [options] The options.
     * @param {string} [options.filePath] The path to this config data.
     * @param {string} [options.name] The config name.
     * @param {ConfigArray} [options.parent] The parent config array.
     * @returns {ConfigArray} Loaded config.
     */
    create(configData, { filePath, name, parent } = {}) {
        return createConfigArray(
            configData
                ? this._normalizeConfigData(configData, { filePath, name })
                : null,
            parent
        );
    }

    /**
     * Load a config file.
     * @param {string} filePath The path to a config file. This can be a name of shareable configs for backward compatibility.
     * @param {Object} [options] The options.
     * @param {string} [options.name] The config name.
     * @param {ConfigArray} [options.parent] The parent config array.
     * @returns {ConfigArray|null} Loaded config.
     */
    loadFile(filePath, { name, parent } = {}) {
        return createConfigArray(
            this._loadConfigData(normalizePath(filePath, this._cwd), { name }),
            parent
        );
    }

    /**
     * Load the config file on a given directory if exists.
     * @param {string} directoryPath The path to a directory.
     * @param {Object} [options] The options.
     * @param {string} [options.name] The config name.
     * @param {ConfigArray} [options.parent] The parent config array.
     * @returns {ConfigArray|null} Loaded config. `null` if any config doesn't exist.
     */
    loadOnDirectory(directoryPath, { name, parent } = {}) {
        return createConfigArray(
            this._loadConfigDataOnDirectory(directoryPath, { name }),
            parent
        );
    }

    /**
     * Load config files in the ancestors of a given directory.
     *
     * For example, when `/path/to/a/dir` was given, it checks `/path/to/a`,
     * `/path/to`, `/path`, and `/`.
     * If `root:true` was found in the middle then it stops the check.
     *
     * @param {string} directoryPath The path to start.
     * @param {Object} [options] The options.
     * @param {ConfigArray} [options.parent] The parent config array.
     * @param {boolean} [options.usePersonalEslintrc] The flag to use config on the home directory.
     * @returns {ConfigArray} The loaded config.
     * @private
     */
    loadInAncestors(
        directoryPath,
        { parent = null, usePersonalEslintrc = true } = {}
    ) {
        debug("Loading config files in ancestor directories.");

        const configArray = new ConfigArray(...(parent || []));
        let prevPath = directoryPath;
        let currentPath = path.dirname(directoryPath);

        // Load regular config files.
        do {
            let directoryConfig;

            try {
                directoryConfig = this._loadConfigDataOnDirectory(currentPath);
            } catch (error) {
                if (error.code === "EACCES" || error.code === "EPERM") {
                    debug(`Stop traversing because of ${error.code}.`);
                    break;
                }
                throw error;
            }

            // Merge.
            if (directoryConfig) {
                const array = new ConfigArray(...directoryConfig);

                configArray.unshift(...array);

                // Stop if it's root.
                if (array.isRoot()) {
                    break;
                }
            }

            prevPath = currentPath;
            currentPath = path.dirname(currentPath);
        } while (currentPath && currentPath !== prevPath);

        // Load the personal config file if there are no regular files.
        if (configArray.length === 0 && usePersonalEslintrc) {
            debug("Loading config files in the home directory.");

            const personalConfig =
                this._loadConfigDataOnDirectory(os.homedir());

            if (personalConfig) {
                configArray.unshift(...personalConfig);
            }
        }

        debug("Loaded config files in ancestor directories.");
        return configArray;
    }


    /**
     * Load a given config file.
     * @param {string} filePath The path to a config file.
     * @param {Object} [options] The options.
     * @param {string} [options.name] The config name.
     * @returns {IterableIterator<ConfigArrayElement>} Loaded config.
     * @private
     */
    _loadConfigData(filePath, { name } = {}) {
        debug(`Loading a config data: ${filePath}`);

        const configData = loadConfigFile(filePath);

        if (!configData) {
            throw new Error(`Config data not found: ${name || filePath}`);
        }
        return this._normalizeConfigData(configData, { filePath, name });
    }

    /**
     * Load the config file on a given directory if exists.
     * @param {string} directoryPath The path to a directory.
     * @param {Object} [options] The options.
     * @param {string} [options.name] The config name.
     * @returns {IterableIterator<ConfigArrayElement> | null} Loaded config. `null` if any config doesn't exist.
     * @private
     */
    _loadConfigDataOnDirectory(directoryPath, { name } = {}) {
        for (const filename of configFilenames) {
            const filePath = path.join(directoryPath, filename);

            try {
                const originalEnabled = debug.enabled;
                let configData;

                debug.enabled = false;
                try {
                    configData = loadConfigFile(filePath);
                } finally {
                    debug.enabled = originalEnabled;
                }

                if (configData) {
                    debug(`Config file found: ${filePath}`);
                    return this._normalizeConfigData(
                        configData,
                        { filePath, name }
                    );
                }
            } catch (error) {
                if (error.code !== "ENOENT" && error.code !== "MODULE_NOT_FOUND") {
                    throw error;
                }
            }
        }

        debug("Config file not found.");
        return null;
    }

    /**
     * Normalize a given config to an array.
     * @param {ConfigData|ConfigData[]} configData The config data to normalize.
     * @param {Object} [options] The file path.
     * @param {string} [options.filePath] The file path of this config.
     * @param {string} [options.name] The name of this config.
     * @returns {IterableIterator<ConfigArrayElement>} The normalized config.
     * @private
     */
    _normalizeConfigData(configData, options) {
        if (Array.isArray(configData)) {
            return this._normalizeArrayConfigData(configData, options);
        }
        return this._normalizeObjectConfigData(configData, options);
    }

    /**
     * Normalize a given config to an array.
     * @param {ConfigData[]} configData The config data to normalize.
     * @param {Object} [options] The file path.
     * @param {string} [options.filePath] The file path of this config.
     * @param {string} [options.name] The name of this config.
     * @returns {IterableIterator<ConfigArrayElement>} The normalized config.
     * @private
     */
    *_normalizeArrayConfigData(configData, { filePath, name }) {
        let i = 0;

        for (const element of configData) {
            const index = i++;

            if (typeof element === "string") {
                yield* this._loadExtends(
                    element,
                    { filePath, name: `${name}#[${index}]` }
                );
            } else {
                yield* this._normalizeConfigData(
                    element,
                    { filePath, name: `${name}#[${index}]` }
                );
            }
        }
    }

    /**
     * Normalize a given config to an array.
     * @param {ConfigData} configData The config data to normalize.
     * @param {Object} [options] The file path.
     * @param {string} [options.filePath] The file path of this config.
     * @param {string} [options.name] The name of this config.
     * @returns {IterableIterator<ConfigArrayElement>} The normalized config.
     * @private
     */
    *_normalizeObjectConfigData(configData, options) {
        const { files, excludedFiles, ...configBody } = configData;
        const matchFile = defineMatch(files, excludedFiles);
        const elements = this._normalizeObjectConfigDataWithoutFilesProperty(
            configBody,
            options
        );

        if (!matchFile) {
            yield* elements;
            return;
        }

        for (const element of elements) {
            if (element.matchFile) {
                element.matchFile = defineAnd(matchFile, element.matchFile);
            } else {
                element.matchFile = matchFile;
            }
            yield element;
        }
    }

    /**
     * Normalize a given config to an array.
     * @param {ConfigData} configData The config data to normalize.
     * @param {Object} [options] The file path.
     * @param {string} [options.filePath] The file path of this config.
     * @param {string} [options.name] The name of this config.
     * @returns {IterableIterator<ConfigArrayElement>} The normalized config.
     * @private
     */
    *_normalizeObjectConfigDataWithoutFilesProperty(
        configData,
        {
            filePath = "",
            name = filePath && path.relative(this._cwd, filePath)
        } = {}
    ) {
        const {
            extends: extend,
            overrides: overrideList = [],
            parser,
            plugins: pluginList,
            ...configBody
        } = configData;
        const extendList = Array.isArray(extend)
            ? extend
            : [extend].filter(Boolean);

        // Flatten `extends`.
        for (const extendName of extendList) {
            yield* this._loadExtends(extendName, { filePath, name });
        }

        // Load parser & plugins.
        if (parser) {
            configBody.parser = this._loadParser(parser, filePath);
        }
        if (pluginList) {
            configBody.plugins = this._loadPlugins(pluginList, filePath);
            yield* this._takeFileExtensionProcessors(
                configBody.plugins,
                { name, filePath }
            );
        }

        // Yield the body except `extends` and `overrides`.
        yield new ConfigArrayElement(configBody, { name, filePath });

        // Flatten `overries`.
        for (let i = 0; i < overrideList.length; ++i) {
            yield* this._normalizeConfigData(
                overrideList[i],
                { filePath, name: `${name}#overrides[${i}]` }
            );
        }
    }

    /**
     * Load configs of an element in `extends`.
     * @param {string} extendName The name of a base config.
     * @param {Object} [options] The file path.
     * @param {string} [options.filePath] The file path which has the `extends` property.
     * @param {string} [options.name] The name of the config which has the `extends` property.
     * @returns {IterableIterator<ConfigArrayElement>} The normalized config.
     * @private
     */
    *_loadExtends(extendName, { filePath, name: parentName }) {
        debug(`Loading 'extends' of a config file: ${extendName} from ${filePath}`);

        // Debug name.
        const name = `${parentName} » ${extendName}`;

        // Core config
        if (extendName.startsWith("eslint:")) {
            if (extendName === "eslint:recommended") {
                yield* this._loadConfigData(eslintRecommendedPath, { name });
            } else if (extendName === "eslint:all") {
                yield* this._loadConfigData(eslintAllPath, { name });
            } else {
                throw configMissingError(extendName);
            }

        // Plugin's config
        } else if (extendName.startsWith("plugin:")) {
            const slashIndex = extendName.lastIndexOf("/");
            const pluginName = extendName.slice(7, slashIndex);
            const configName = extendName.slice(slashIndex + 1);
            const plugin = this._loadPlugin(pluginName, filePath);
            const pluginConfigData =
                plugin.definition &&
                plugin.definition.configs &&
                plugin.definition.configs[configName];

            if (pluginConfigData) {
                validateConfigSchema(pluginConfigData, name);
                yield* this._normalizeConfigData(
                    pluginConfigData,
                    { filePath: plugin.filePath, name }
                );
            } else {
                throw configMissingError(extendName);
            }

        // Shareable config
        } else {
            const configFilePath = ModuleResolver.resolve(
                isFilePath(extendName)
                    ? extendName
                    : naming.normalizePackageName(extendName, "eslint-config"),
                filePath
            );

            yield* this._loadConfigData(configFilePath, { name });
        }
    }

    /**
     * Load given plugins.
     * @param {string[]} names The plugin names to load.
     * @param {string} importerPath The path to a config file that imports it.
     * @returns {Object} The loaded parser.
     * @private
     */
    _loadPlugins(names, importerPath) {
        if (Array.isArray(names)) {
            return names.reduce((map, name) => {
                if (isFilePath(name)) {
                    throw new Error("Plugins array cannot includes file paths.");
                }
                const plugin = this._loadPlugin(name, importerPath);

                map[plugin.id] = plugin;

                return map;
            }, {});
        }

        return Object.entries(names).reduce((map, [id, nameOrPath]) => {
            const plugin = this._loadPlugin(nameOrPath, importerPath);

            map[id] = plugin;

            return map;
        }, {});
    }

    /**
     * Load a given parser.
     * @param {string} nameOrPath The package name or the path to a parser file.
     * @param {string} importerPath The path to a config file that imports it.
     * @returns {{definition:Object, filePath:string, id:string, importerPath:string}|{error:Error, id:string, importerPath:string}} The loaded parser.
     */
    _loadParser(nameOrPath, importerPath) {
        debug(`Loading parser: ${nameOrPath} from ${importerPath}`);

        // Check for additional pool.
        const parser = this._additionalPluginPool.get(nameOrPath);

        if (parser) {
            return {
                definition: parser,
                filePath: importerPath,
                id: nameOrPath,
                importerPath
            };
        }

        try {
            const filePath = ModuleResolver.resolve(nameOrPath, importerPath);

            return {
                definition: require(filePath),
                filePath,
                id: nameOrPath,
                importerPath
            };
        } catch (error) {
            return {
                error: error instanceof Error ? error : new Error(error),
                id: nameOrPath,
                importerPath
            };
        }
    }

    /**
     * Load a given plugin.
     * @param {string} nameOrPath The plugin name to load.
     * @param {string} importerPath The path to a config file that imports it.
     * @returns {{definition:Object, filePath:string, id:string, importerPath:string}|{error:Error, id:string, importerPath:string}} The loaded plugin.
     * @private
     */
    _loadPlugin(nameOrPath, importerPath) {
        debug(`Loading plugin: ${nameOrPath} from ${importerPath}`);

        let request, id;

        if (isFilePath(nameOrPath)) {
            request = id = nameOrPath;
        } else {
            request = naming.normalizePackageName(nameOrPath, "eslint-plugin");
            id = naming.getShorthandName(request, "eslint-plugin");

            if (nameOrPath.match(/\s+/)) {
                const error = new Error(`Whitespace found in plugin name '${nameOrPath}'`);

                error.messageTemplate = "whitespace-found";
                error.messageData = { pluginName: request };

                return { error, id, importerPath };
            }

            // Check for additional pool.
            const plugin =
                this._additionalPluginPool.get(request) ||
                this._additionalPluginPool.get(id);

            if (plugin) {
                return {
                    definition: plugin,
                    filePath: importerPath,
                    id,
                    importerPath
                };
            }
        }

        try {
            const filePath = ModuleResolver.resolve(request, importerPath);

            return {
                definition: require(filePath),
                filePath,
                id,
                importerPath
            };
        } catch (error) {
            if (error && error.code === "MODULE_NOT_FOUND") {
                debug(`Failed to load plugin ${request}.`);
                error.message = `Failed to load plugin ${request}: ${error.message}`;
                error.messageTemplate = "plugin-missing";
                error.messageData = {
                    pluginName: request,
                    importerPath
                };
            }

            return {
                error: error instanceof Error ? error : new Error(error),
                id,
                importerPath
            };
        }
    }

    /**
     * Take file expression processors as config array elements.
     * @param {Object} plugins The plugin definitions.
     * @param {Object} [options] The file path.
     * @param {string} [options.filePath] The file path of this config.
     * @param {string} [options.name] The name of this config.
     * @returns {IterableIterator<ConfigArrayElement>} The config array elements of file expression processors.
     * @private
     */
    *_takeFileExtensionProcessors(plugins, { filePath, name }) {
        for (const pluginId of Object.keys(plugins)) {
            const processors =
                plugins[pluginId] &&
                plugins[pluginId].definition &&
                plugins[pluginId].definition.processors;

            if (!processors) {
                continue;
            }

            for (const processorId of Object.keys(processors)) {
                if (processorId.startsWith(".")) {
                    yield* this._normalizeConfigData(
                        {
                            files: [`*${processorId}`],
                            processor: `${pluginId}/${processorId}`
                        },
                        {
                            filePath,
                            name: `${name}#processors[${processorId}]`
                        }
                    );
                }
            }
        }
    }
}

module.exports = ConfigArrayFactory;