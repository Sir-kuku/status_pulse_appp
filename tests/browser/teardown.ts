export default async function teardown() {
  await fetch('http://127.0.0.1:3107/__browser_fixture_stop', { method: 'POST' }).catch(() => undefined);
}
