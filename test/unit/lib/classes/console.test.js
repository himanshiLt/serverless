'use strict';

const chai = require('chai');
const path = require('path');
const runServerless = require('../../../utils/run-serverless');
const getRequire = require('../../../../lib/utils/get-require');

// Configure chai
chai.use(require('chai-as-promised'));
const expect = require('chai').expect;

describe('test/unit/lib/classes/console.test.js', () => {
  describe('enabled', () => {
    let serverless;
    before(async () => {
      const ServerlessSDKMock = class ServerlessSDK {
        getOrgByName() {
          return 'xxxx';
        }
      };
      ({ serverless } = await runServerless({
        fixture: 'function',
        command: 'package',
        configExt: { console: true, org: 'testorg' },
        env: { SERVERLESS_ACCESS_KEY: 'dummy' },
        modulesCacheStub: {
          [getRequire(path.dirname(require.resolve('@serverless/dashboard-plugin'))).resolve(
            '@serverless/platform-client'
          )]: {
            ServerlessSDK: ServerlessSDKMock,
          },
        },
      }));
    });
    it('should enable console with `console: true` and `org` set', () => {
      expect(serverless.console.isEnabled).to.be.true;
    });
  });

  describe('errors', () => {
    it('should abort when console enabled but not authenticated', async () => {
      expect(
        runServerless({
          fixture: 'function',
          command: 'package',
          configExt: { console: true, org: 'testorg' },
        })
      ).to.eventually.be.rejected.and.have.property('code', 'CONSOLE_NOT_AUTHENTICATED');
    });
  });

  describe('disabled', () => {
    it('should not enable console when no `console: true`', async () => {
      const { serverless } = await runServerless({
        fixture: 'function',
        command: 'package',
        configExt: { org: 'testorg' },
      });
      expect(serverless.console.isEnabled).to.be.false;
    });
    it('should not enable console when not supported command', async () => {
      const { serverless } = await runServerless({
        fixture: 'function',
        command: 'print',
        configExt: { console: true, org: 'testorg' },
      });
      expect(serverless.console.isEnabled).to.be.false;
    });
  });
});
