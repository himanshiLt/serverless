'use strict';

const _ = require('lodash');

module.exports = class Console {
  constructor(serverless) {
    this.serverless = serverless;
    const { configurationInput: configuration } = serverless;
    this.isEnabled = Boolean(_.get(configuration, 'console') && _.get(configuration, 'org'));
  }
};
