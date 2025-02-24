'use strict';
const validate = require('./lib/validate');
const setBucketName = require('./lib/set-bucket-name');
const updateStack = require('./lib/update-stack');
const monitorStack = require('./lib/monitor-stack');
const waitForChangeSetCreation = require('./lib/wait-for-change-set-creation');
const getCreateChangeSetParams = require('./lib/get-create-change-set-params');
const getExecuteChangeSetParams = require('./lib/get-execute-change-set-params');
const findAndGroupDeployments = require('./utils/find-and-group-deployments');
const ServerlessError = require('../../serverless-error');
const { style, log, progress } = require('@serverless/utils/log');

const mainProgress = progress.get('main');

class AwsRollback {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider('aws');

    Object.assign(
      this,
      validate,
      setBucketName,
      updateStack,
      monitorStack,
      waitForChangeSetCreation,
      getCreateChangeSetParams,
      getExecuteChangeSetParams
    );

    this.hooks = {
      'before:rollback:initialize': async () => this.validate(),

      'rollback:rollback': async () => {
        if (!this.options.timestamp) {
          log.notice(
            'Select a timestamp from the deploy list below and run "sls rollback -t <timestamp>" to rollback your service to a specific version.'
          );
          log.notice();
          await this.serverless.pluginManager.spawn('deploy:list');
          return;
        }

        log.notice();
        log.notice(
          `Rolling back ${this.serverless.service.service} to timestamp "${this.options.timestamp}"`
        );
        log.info(); // Ensure gap between verbose logging

        await this.setBucketName();
        await this.setStackToUpdate();
        mainProgress.notice('Validating', { isMainEvent: true });
        const result = await this.updateStack();

        log.notice();
        if (result) {
          log.notice.success(
            `Service rolled back to timestamp "${this.options.timestamp}" ${style.aside(
              `(${Math.floor(
                (Date.now() - this.serverless.pluginManager.commandRunStartTime) / 1000
              )}s)`
            )}`
          );
        } else {
          log.notice.skip(
            `No updates to be performed. Rollback skipped. ${style.aside(
              `(${Math.floor(
                (Date.now() - this.serverless.pluginManager.commandRunStartTime) / 1000
              )}s)`
            )}`
          );
        }
      },
    };
  }

  async setStackToUpdate() {
    const service = this.serverless.service;
    const serviceName = this.serverless.service.service;
    const stage = this.provider.getStage();
    const deploymentPrefix = this.provider.getDeploymentPrefix();
    const prefix = `${deploymentPrefix}/${serviceName}/${stage}`;

    const response = await this.provider.request('S3', 'listObjectsV2', {
      Bucket: this.bucketName,
      Prefix: prefix,
    });
    const deployments = findAndGroupDeployments(response, deploymentPrefix, serviceName, stage);

    if (deployments.length === 0) {
      const msg = "Couldn't find any existing deployments.";
      const hint = 'Please verify that stage and region are correct.';
      throw new ServerlessError(`${msg} ${hint}`, 'ROLLBACK_DEPLOYMENTS_NOT_FOUND');
    }

    let date = new Date(this.options.timestamp);

    // The if below is added due issues#5664 - Check it for more details
    if (date instanceof Date === false || isNaN(date.valueOf())) {
      date = new Date(Number(this.options.timestamp));
    }

    const dateString = `${date.getTime().toString()}-${date.toISOString()}`;
    const exists = deployments.some((deployment) =>
      deployment.some(
        (item) =>
          item.directory === dateString &&
          item.file === this.provider.naming.getCompiledTemplateS3Suffix()
      )
    );

    if (!exists) {
      const msg = `Couldn't find a deployment for the timestamp: ${this.options.timestamp}.`;
      const hint = 'Please verify that the timestamp, stage and region are correct.';
      throw new ServerlessError(`${msg} ${hint}`, 'ROLLBACK_DEPLOYMENT_NOT_FOUND');
    }

    service.package.artifactDirectoryName = `${prefix}/${dateString}`;
  }
}

module.exports = AwsRollback;
