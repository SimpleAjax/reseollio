#!/usr/bin/env node

/**
 * Reseolio CLI
 * 
 * This CLI provides utilities for managing Reseolio jobs and viewing the dashboard.
 * 
 * Usage:
 *   npx reseolio ui        - Open the local dashboard (coming soon)
 *   npx reseolio status    - Check connection to reseolio-core
 *   npx reseolio --help    - Show this help message
 */

const args = process.argv.slice(2);
const command = args[0];

const VERSION = '0.1.3';

const HELP = `
Reseolio CLI v${VERSION}

Usage:
  npx reseolio <command>

Commands:
  ui              Open the local dashboard (coming soon)
  status          Check reseolio-core status
  version         Show version

Options:
  --help, -h      Show this help message
  --version, -v   Show version

Examples:
  npx reseolio ui
  npx reseolio status

Documentation: https://github.com/SimpleAjax/reseollio
`;

switch (command) {
    case 'ui':
        console.log('');
        console.log('🔷 Reseolio Dashboard');
        console.log('');
        console.log('The visual dashboard is coming soon in v0.2.0!');
        console.log('');
        console.log('Track progress: https://github.com/SimpleAjax/reseollio/issues');
        console.log('');
        break;

    case 'status':
        console.log('');
        console.log('🔷 Reseolio Status Check');
        console.log('');
        console.log('Status check will be available in the next release.');
        console.log('For now, ensure your application can connect to reseolio-core.');
        console.log('');
        break;

    case 'version':
    case '--version':
    case '-v':
        console.log(`reseolio v${VERSION}`);
        break;

    case '--help':
    case '-h':
    case 'help':
    case undefined:
        console.log(HELP);
        break;

    default:
        console.error(`Unknown command: ${command}`);
        console.log('Run "npx reseolio --help" for usage information.');
        process.exit(1);
}
