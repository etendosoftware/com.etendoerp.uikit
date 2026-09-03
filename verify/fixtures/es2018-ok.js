/* Fixture for gate G0: proof that the kernel's own minifier passes ES2018.
 * If this file ever fails the gate, fact F1 is wrong and must be corrected. */
(function () {
  const NAMES = ['draft', 'completed', 'closed'];
  let counter = 0;

  const label = (key, fallback = key) => `label:${key}/${fallback}`;

  class Box {
    constructor({ id, rows = [] }) {
      this.id = id;
      this.rows = [...rows];
    }
    get size() {
      return this.rows.length;
    }
    add(...more) {
      this.rows.push(...more);
      return this;
    }
  }

  async function load(fetchRows) {
    try {
      const { rows, total } = await fetchRows();
      return new Box({ id: `box-${(counter += 1)}`, rows }).add(...NAMES).size + total;
    } catch (err) {
      return -1;
    }
  }

  const [first, ...rest] = NAMES;
  const summary = { first, rest, label: label('x'), load };
  window.__uikitFixture = summary;
}());
