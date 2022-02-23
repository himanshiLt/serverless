'use strict';

const _ = require('lodash');
const d = require('d');
const lazy = require('d/lazy');
const path = require('path');
const fsp = require('fs').promises;
const fetch = require('node-fetch');
const { log } = require('@serverless/utils/log');
const isAuthenticated = require('@serverless/dashboard-plugin/lib/is-authenticated');
const { getPlatformClientWithAccessKey } = require('@serverless/dashboard-plugin/lib/client-utils');
const ServerlessError = require('../serverless-error');

const supportedCommands = new Set(['deploy', 'deploy function', 'package', 'rollback']);
const devVersionTimeBase = new Date(2022, 1, 17).getTime();

class Console {
  constructor(serverless) {
    this.serverless = serverless;
    // Used to confirm that we obtained compatible console state data for deployment
    this.stateSchemaVersion = '1';
    this.extensionLayerName = 'sls-console-otel-extension';
  }

  async initialize() {
    this.isEnabled = (() => {
      const {
        configurationInput: configuration,
        processedInput: { commands, options },
      } = this.serverless;
      if (!_.get(configuration, 'console')) return false;
      this.org = options.org || configuration.org;
      if (!this.org) return false;
      const command = commands.join(' ');
      if (!supportedCommands.has(command)) return false;

      const providerName = configuration.provider.name || configuration.provider;
      if (providerName !== 'aws') {
        log.error(`Provider "${providerName}" is currently not supported by the console`);
        return false;
      }

      if (command !== 'deploy' || !options.package) {
        if (
          !Object.values(this.serverless.service.functions).some((functionConfig) =>
            this.isFunctionSupported(functionConfig)
          )
        ) {
          log.warning(
            "Cannot enable console: Service doesn't configure any function with supported runtime"
          );
          return false;
        }
      }
      return true;
    })();
    if (!this.isEnabled) return;
    if (!isAuthenticated()) {
      const errorMessage = process.env.CI
        ? 'You are not currently logged in. Follow instructions in http://slss.io/run-in-cicd to setup env vars for authentication.'
        : 'You are not currently logged in. To log in, run "serverless login"';
      throw new ServerlessError(errorMessage, 'CONSOLE_NOT_AUTHENTICATED');
    }
    this.provider = this.serverless.getProvider('aws');
    this.sdk = await getPlatformClientWithAccessKey(this.org);
    this.orgId = (await this.sdk.getOrgByName(this.org)).orgUid;
    this.serviceId = `${this.serverless.service.service}-${this.provider.getStage()}`;
    this.otelIngestionUrl = (() => {
      if (process.env.SLS_CONSOLE_OTEL_INGESTION_URL) {
        return process.env.SLS_CONSOLE_OTEL_INGESTION_URL;
      }
      return process.env.SERVERLESS_PLATFORM_STAGE === 'dev'
        ? 'https://core.serverless-dev.com/ingestion/kinesis'
        : 'https://core.serverless.com/ingestion/kinesis';
    })();
  }

  isFunctionSupported({ handler, runtime }) {
    if (!handler) return false; // Docker container image (not supported yet)
    if (!runtime) return true; // Default is supported nodejs runtime
    return runtime.startsWith('nodejs');
  }

  async createOtelIngestionToken() {
    const response = await fetch(`${this.otelIngestionUrl}/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.sdk.accessKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orgId: this.orgId,
        serviceId: this.serviceId,
      }),
    });
    if (!response.ok) {
      throw new ServerlessError(
        `Cannot deploy to the Console: Cannot create token (${
          response.status
        }: ${await response.text()})`
      );
    }
    const responseBody = await response.json();
    return responseBody.accessToken;
  }

  async activateOtelIngestionToken() {
    const response = await fetch(`${this.otelIngestionUrl}/token`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.sdk.accessKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orgId: this.orgId,
        serviceId: this.serviceId,
        token: await this.deferredOtelIngestionToken,
      }),
    });
    if (!response.ok) {
      throw new ServerlessError(
        `Cannot deploy to the Console: Cannot activate token (${
          response.status
        }: ${await response.text()})`,
        'CONSOLE_TOKEN_CREATION_FAILURE'
      );
    }
    await response.text();
  }

  async deactivateOtherOtelIngestionTokens() {
    const searchParams = new URLSearchParams();
    searchParams.set('orgId', this.orgId);
    searchParams.set('serviceId', this.orgId);
    searchParams.set('token', await this.deferredOtelIngestionToken);
    const response = await fetch(`${this.otelIngestionUrl}/tokens?${searchParams}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.sdk.accessKey}`,
      },
    });
    if (!response.ok) {
      log.error(
        'Console communication problem ' +
          'when deactivating no longer used otel ingestion tokens: %d %s',
        response.status,
        await response.text()
      );
      return;
    }
    await response.text();
  }

  async deactivateOtelIngestionToken() {
    const response = await fetch(
      `${this.otelIngestionUrl}/token?token=${await this.deferredOtelIngestionToken}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.sdk.accessKey}`,
        },
      }
    );
    if (!response.ok) {
      log.error(
        'Console communication problem when deactivating otel ingestion token: %d %s',
        response.status,
        await response.text()
      );
      return;
    }
    await response.text();
  }

  overrideSettings({ otelIngestionToken, extensionLayerVersionPostfix, serviceId }) {
    Object.defineProperties(this, {
      deferredOtelIngestionToken: d(Promise.resolve(otelIngestionToken)),
      extensionLayerVersionPostfix: d(extensionLayerVersionPostfix),
      serviceId: d('cew', serviceId),
    });
  }

  compileOtelExtensionLayer() {
    this.serverless.service.provider.compiledCloudFormationTemplate.Resources[
      this.provider.naming.getConsoleExtensionLayerLogicalId()
    ] = {
      Type: 'AWS::Lambda::LayerVersion',
      Properties: {
        Content: {
          S3Bucket: { Ref: 'ServerlessDeploymentBucket' },
          S3Key: `${this.serverless.service.package.artifactsS3KeyDirname}/${this.extensionLayerFilename}`,
        },
        LayerName: this.extensionLayerName,
      },
    };
  }

  async packageOtelExtensionLayer() {
    await fsp.copyFile(
      require.resolve('@serverless/aws-lambda-otel-extension-dist/extension.zip'),
      path.join(this.serverless.serviceDir, '.serverless', this.extensionLayerFilename)
    );
  }
}

Object.defineProperties(
  Console.prototype,
  lazy({
    deferredFunctionEnvironmentVariables: d(function () {
      return this.deferredOtelIngestionToken.then((otelIngestionToken) => ({
        SLS_OTEL_REPORT_REQUEST_HEADERS: `serverless-token=${otelIngestionToken}`,
        SLS_OTEL_REPORT_METRICS_URL: `${this.otelIngestionUrl}/v1/metrics`,
        SLS_OTEL_REPORT_TRACES_URL: `${this.otelIngestionUrl}/v1/traces`,
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-extension/otel-handler',
      }));
    }),
    deferredOtelIngestionToken: d(function () {
      return this.createOtelIngestionToken();
    }),
    extensionLayerFilename: d(function () {
      return `sls-otel.${this.extensionLayerVersionPostfix}.zip`;
    }),
    extensionLayerVersionPostfix: d(() => {
      return (this._extensionLayerVersionPostfix = process.env.SLS_OTEL_LAYER_DEV_BUILD
        ? (Date.now() - devVersionTimeBase).toString(32)
        : require('@serverless/aws-lambda-otel-extension-dist/package').version);
    }),
  })
);

module.exports = Console;
