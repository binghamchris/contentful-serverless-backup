// Template + source invariants enforcing the no-standing-cost, no-quota
// observability decision so it cannot silently erode.
// Validates: Requirements 11.1-11.7, 50.3, 50.4.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTemplate, resourcesOfType } = require('../helpers/cfn-template');

const template = loadTemplate();

describe('Req 11: observability carries no standing cost and no quota cost', () => {
  const forbidden = {
    'AWS::CloudWatch::Alarm': '11.1',
    'AWS::CloudWatch::CompositeAlarm': '11.2',
    'AWS::Logs::MetricFilter': '11.3',
    'AWS::CloudWatch::Dashboard': '11.4',
  };

  for (const [type, criterion] of Object.entries(forbidden)) {
    it(`declares no ${type} (criterion ${criterion})`, () => {
      const found = resourcesOfType(template, type);
      assert.equal(found.length, 0, `Found ${type}: ${found.join(', ')}`);
    });
  }

  it('declares no scheduled or time-based trigger (criterion 11.7)', () => {
    const scheduleTypes = [
      'AWS::Events::Rule',
      'AWS::Scheduler::Schedule',
      'AWS::Pipes::Pipe',
    ];
    for (const type of scheduleTypes) {
      const found = resourcesOfType(template, type);
      // An Events::Rule is only forbidden if it carries a ScheduleExpression.
      if (type === 'AWS::Events::Rule') {
        const scheduled = found.filter(
          (n) => template.Resources[n].Properties &&
            template.Resources[n].Properties.ScheduleExpression
        );
        assert.equal(scheduled.length, 0, `Found scheduled rule(s): ${scheduled.join(', ')}`);
      } else {
        assert.equal(found.length, 0, `Found ${type}: ${found.join(', ')}`);
      }
    }
  });
});

describe('Req 11.5: no source file publishes a CloudWatch custom metric', () => {
  const sourceDirs = ['backup-lambda', 'filter-lambda', 'notifier-lambda', 'deploy'];
  const repoRoot = path.join(__dirname, '../..');

  function jsFiles(dir) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs)
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.join(abs, f));
  }

  it('uses neither PutMetricData nor an Embedded Metric Format _aws block', () => {
    const offenders = [];
    for (const dir of sourceDirs) {
      for (const file of jsFiles(dir)) {
        const src = fs.readFileSync(file, 'utf8');
        if (src.includes('PutMetricData') || /["']_aws["']\s*:/.test(src)) {
          offenders.push(path.relative(repoRoot, file));
        }
      }
    }
    assert.equal(offenders.length, 0, `Custom-metric publication found in: ${offenders.join(', ')}`);
  });
});
