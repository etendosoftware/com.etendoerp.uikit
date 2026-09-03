/* Fixture for gate G0: a real syntax error. The gate MUST reject this file.
 * A gate that reports this as valid is not checking anything. */
(function () {
  const rows = [1, 2, 3;
  return rows.
}());
