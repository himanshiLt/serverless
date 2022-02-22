'use strict';

const _ = require('lodash');
const ensureString = require('type/string/ensure');
const fetch = require('node-fetch');
const { log } = require('@serverless/utils/log');
const isAuthenticated = require('@serverless/dashboard-plugin/lib/is-authenticated');
const { getPlatformClientWithAccessKey } = require('@serverless/dashboard-plugin/lib/client-utils');
const ServerlessError = require('../serverless-error');

const supportedCommands = new Set(['deploy', 'deploy function', 'package', 'rollback']);
const devVersionTimeBase = new Date(2022, 1, 17).getTime();

module.exports = class Console {
  constructor(serverless) {
    this.serverless = serverless;
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
      if (!supportedCommands.has(commands.join(' '))) return false;

      const providerName = configuration.provider.name || configuration.provider;
      if (providerName !== 'aws') {
        log.error(`Provider "${providerName}" is currently not supported by the console`);
        return false;
      }

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
    this.orgUid = await this.sdk.getOrgByName(this.org);
    this.otelIngestionUrl = (() => {
      if (process.env.SLS_CONSOLE_OTEL_INGESTION_URL) {
        return process.env.SLS_CONSOLE_OTEL_INGESTION_URL;
      }
      return process.env.SLS_PLATFORM_STAGE === 'dev'
        ? 'https://core.serverless-dev.com/ingestion/kinesis'
        : 'https://core.serverless.com/ingestion/kinesis';
    })();
  }

  isFunctionSupported({ handler, runtime }) {
    if (!handler) return false;
    if (!runtime) return true;
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
        orgId: this.orgUid,
        serviceId: `${this.serverless.service.service}-${this.provider.getStage()}`,
      }),
    });
    this.otelIngestionToken = (await response.json()).accessToken;
  }

  get deferredOtelIngestionToken() {
    if (!this._deferredOtelIngestionToken) {
      this._deferredOtelIngestionToken = this.createOtelIngestionToken();
    }
    return this._deferredOtelIngestionToken;
  }
  set otelIngestionToken(token) {
    this._deferredOtelIngestionToken = Promise.resolve(ensureString(token));
  }

  get deferredFunctionEnvironmentVariables() {
    return this.deferredOtelIngestionToken.then((otelIngestionToken) => ({
      SLS_OTEL_REPORT_REQUEST_HEADERS: `serverless-token=${otelIngestionToken}`,
      SLS_OTEL_REPORT_METRICS_URL: `${this.otelIngestionUrl}/v1/metrics`,
      SLS_OTEL_REPORT_TRACES_URL: `${this.otelIngestionUrl}/v1/traces`,
      AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-extension/otel-handler',
    }));
  }

  get extensionLayerVersionPostfix() {
    if (!this._extensionLayerVersionPostfix) {
      this._extensionLayerVersionPostfix = process.env.SLS_OTEL_LAYER_DEV_BUILD
        ? (Date.now() - devVersionTimeBase).toString(32)
        : require('@serverless/aws-lambda-otel-extension-dist/package').version;
    }
    return this._extensionLayerVersionPostfix;
  }

  async compileOtelExtensionLayer() {
    const layerName = `sls-otel.${this.extensionLayerVersionPostfix}`;
    this.serverless.service.provider.compiledCloudFormationTemplate.Resources[
      this.provider.naming.getConsoleExtensionLayerLogicalId()
    ] = {
      Type: 'AWS::Lambda::LayerVersion',
      Properties: {
        Content: {
          S3Bucket: { Ref: 'ServerlessDeploymentBucket' },
          S3Key: `${this.serverless.service.package.artifactsS3KeyDirname}/${layerName}.zip`,
        },
        LayerName: 'sls-console-otel-extension',
      },
    };
  }
};
