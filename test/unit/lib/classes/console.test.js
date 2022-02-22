'use strict';

const chai = require('chai');
const runServerless = require('../../../utils/run-serverless');

// Configure chai
chai.use(require('chai-as-promised'));
const expect = require('chai').expect;

describe('test/unit/lib/classes/console.test.js', () => {
  describe('enabled', () => {
    let serverless;
    before(async () => {
      ({ serverless } = await runServerless({
        fixture: 'function',
        command: 'package',
        configExt: { console: true, org: 'testorg' },
        env: { SERVERLESS_ACCESS_KEY: 'dummy' },
      }));
    });
    it('should enable console with `console: true` and `org` set', () => {
      expect(serverless.console.isEnabled).to.be.true;
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
