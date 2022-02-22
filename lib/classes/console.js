'use strict';

const _ = require('lodash');

const supportedCommands = new Set(['deploy', 'deploy function', 'package', 'rollback']);

module.exports = class Console {
  constructor(serverless) {
    this.serverless = serverless;
    const {
      configurationInput: configuration,
      processedInput: { commands },
    } = serverless;
    const command = commands.join(' ');
    this.isEnabled =
      supportedCommands.has(command) &&
      Boolean(_.get(configuration, 'console') && _.get(configuration, 'org'));
  }
};
