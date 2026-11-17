const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');

test('能力估分保留摘要，但详情入口、路由和专属练习已删除', () => {
  assert.match(app, /class="card ability-summary"/);
  assert.match(app, /预计卷面分/);
  assert.match(app, /及格概率/);
  assert.doesNotMatch(app, /#\/ability|pageAbility|startAbilityDrill|ability-link|查看详情/);
});

test('详情页专用样式和点击手型已清理', () => {
  assert.doesNotMatch(css, /ability-link|ability-hero|ability-score|ability-range|ability-pass|ability-line/);
  assert.doesNotMatch(css, /\.ability-summary\s*\{[^}]*cursor:\s*pointer/);
});
