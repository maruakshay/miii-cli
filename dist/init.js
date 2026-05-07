import { render } from 'ink';
import React from 'react';
import minimist from 'minimist';
import { loadConfig } from './config.js';
import { SkillLoader } from './skills/loader.js';
import { InputBar } from './tui/InputBar.js';
import { welcome } from './tui/printer.js';
export async function lazyInit() {
    const argv = minimist(process.argv.slice(2), {
        string: ['model', 'url', 'provider'],
        alias: { m: 'model', u: 'url', p: 'provider' },
    });
    const config = loadConfig();
    if (argv.model)
        config.model = argv.model;
    if (argv.url)
        config.baseUrl = argv.url;
    if (argv.provider)
        config.provider = argv.provider;
    const skills = new SkillLoader();
    await skills.loadAll();
    // Print welcome banner to scrollback BEFORE Ink starts
    welcome(config.provider, config.model, process.cwd());
    // Ink renders ONLY the input bar (small footprint at bottom)
    // patchConsole: true (default) ensures console.log output appears above Ink
    const { waitUntilExit } = render(React.createElement(InputBar, { config, skills, cwd: process.cwd() }), { exitOnCtrlC: false });
    await waitUntilExit();
}
//# sourceMappingURL=init.js.map