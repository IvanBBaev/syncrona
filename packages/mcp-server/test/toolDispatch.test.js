const test = require('node:test');
const assert = require('node:assert');

const { dispatchToolPipeline } = require('../dist/toolDispatch.js');

const okResponse = (text) => ({ isError: false, content: [{ type: 'text', text }] });

test('dispatchToolPipeline returns the first non-null handler response and short-circuits', async () => {
  const calls = [];
  const pipeline = [
    () => {
      calls.push('a');
      return null;
    },
    async () => {
      calls.push('b');
      return okResponse('handled-by-b');
    },
    () => {
      calls.push('c');
      return okResponse('should-not-run');
    },
  ];

  const fallback = () => ({ isError: true, content: [{ type: 'text', text: 'Unknown tool' }] });
  const response = await dispatchToolPipeline(pipeline, fallback);

  assert.deepStrictEqual(response, okResponse('handled-by-b'));
  assert.deepStrictEqual(calls, ['a', 'b'], 'handlers after the first match must not be invoked');
});

test('dispatchToolPipeline supports synchronous handlers returning a response directly', async () => {
  const pipeline = [() => okResponse('sync-handled')];
  const response = await dispatchToolPipeline(pipeline, () => okResponse('fallback'));
  assert.deepStrictEqual(response, okResponse('sync-handled'));
});

test('dispatchToolPipeline returns the fallback when every handler declines', async () => {
  let fallbackCalls = 0;
  const pipeline = [
    () => null,
    async () => null,
    () => undefined,
  ];
  const fallback = () => {
    fallbackCalls += 1;
    return { isError: true, content: [{ type: 'text', text: 'Unknown tool: x' }] };
  };

  const response = await dispatchToolPipeline(pipeline, fallback);
  assert.strictEqual(response.isError, true);
  assert.strictEqual(response.content[0].text, 'Unknown tool: x');
  assert.strictEqual(fallbackCalls, 1, 'fallback must be built exactly once');
});

test('dispatchToolPipeline returns the fallback for an empty pipeline', async () => {
  const response = await dispatchToolPipeline([], () => okResponse('empty-fallback'));
  assert.deepStrictEqual(response, okResponse('empty-fallback'));
});
