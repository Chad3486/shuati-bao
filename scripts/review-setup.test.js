const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

test('错题与收藏路由共用新版练习设置页', () => {
  assert.match(app, /'wrong-setup': \(\) => pageReviewSetup\('wrong'\)/);
  assert.match(app, /'star-setup': \(\) => pageReviewSetup\('star'\)/);
  assert.match(app, /id="rv-advanced"/);
  assert.match(app, /class="scope-select" id="rv-open"/);
  assert.match(app, /class="scope-select compact" id="rv-sec-open"/);
});

test('复合范围按钮不会再被旧摘要逻辑覆盖', () => {
  assert.doesNotMatch(app, /rvOpenBtn\.textContent/);
  assert.doesNotMatch(app, /rvSecOpenBtn\.textContent/);
  assert.match(app, /rv-open-title/);
  assert.match(app, /rv-sec-title/);
});

test('进入错题或收藏设置不强制弹题库', () => {
  assert.doesNotMatch(app, /rvSheet\.style\.display = '';\s*\/\/ 默认拉起/);
});
