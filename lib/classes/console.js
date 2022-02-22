'use strict';

const _ = require('lodash');
const isAuthenticated = require('@serverless/dashboard-plugin/lib/is-authenticated');
const ServerlessError = require('../serverless-error');

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
  validate() {
    if (!this.isEnabled) return;
    if (!isAuthenticated()) {
      const errorMessage = process.env.CI
        ? 'You are not currently logged in. Follow instructions in http://slss.io/run-in-cicd to setup env vars for authentication.'
        : 'You are not currently logged in. To log in, run "serverless login"';
      throw new ServerlessError(errorMessage, 'CONSOLE_NOT_AUTHENTICATED');
    }
  }
};
