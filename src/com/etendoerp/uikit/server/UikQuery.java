package com.etendoerp.uikit.server;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.codehaus.jettison.json.JSONArray;
import org.codehaus.jettison.json.JSONObject;
import org.openbravo.dal.core.OBContext;
import org.openbravo.dal.service.OBDal;

/**
 * Shared SQL plumbing for every uikit datasource.
 *
 * The tables a uikit window reads need no DAL entities: reads go through the connection DAL
 * already owns, so they join the current transaction and honour its isolation, and a new window
 * needs no generated entities, no build and no Tomcat restart.
 *
 * Every query is scoped to the readable clients and organizations of the session role. That is the
 * only place access is enforced -- fact F6 records that ViewComponent does not consult
 * OBUIAPP_View_Role_Access, so filtering in the UI would be decoration, not security. This is why
 * {@link #scopeClause(String)} and {@link #bindScope(PreparedStatement, int)} are not optional
 * conveniences: a datasource that skips them is readable by every role in the instance.
 */
public final class UikQuery {

  private UikQuery() {
  }

  /**
   * Renders {@code count} bind placeholders: {@code ?,?,?}. An empty scope renders {@code null}, so
   * the resulting {@code in (null)} matches no row -- which is what an empty scope means.
   *
   * @param count
   *          how many placeholders the caller will bind
   * @return the placeholder list, or {@code null} for an empty scope
   */
  public static String marks(int count) {
    return count < 1 ? "null" : "?" + ",?".repeat(count - 1);
  }

  /**
   * The clients the session role may read.
   *
   * @return the readable client ids
   */
  public static String[] readableClients() {
    return OBContext.getOBContext().getReadableClients();
  }

  /**
   * The organizations the session role may read.
   *
   * @return the readable organization ids
   */
  public static String[] readableOrgs() {
    return OBContext.getOBContext().getReadableOrganizations();
  }

  /**
   * Binds the readable-scope arrays starting at {@code from}; returns the next free index.
   *
   * @param st
   *          the statement whose scope placeholders are being filled
   * @param from
   *          the first index to bind
   * @return the next free bind index
   * @throws Exception
   *           if the statement rejects a bind
   */
  public static int bindScope(PreparedStatement st, int from) throws Exception {
    int i = from;
    for (String c : readableClients()) {
      st.setString(i++, c);
    }
    for (String o : readableOrgs()) {
      st.setString(i++, o);
    }
    return i;
  }

  /**
   * The scope predicate for one table alias, to be bound with
   * {@link #bindScope(PreparedStatement, int)}.
   *
   * @param alias
   *          the alias the query gave the scoped table
   * @return a SQL predicate restricting the alias to the readable scope and to active rows
   */
  public static String scopeClause(String alias) {
    return alias + ".ad_client_id in (" + marks(readableClients().length) + ") and " + alias
        + ".ad_org_id in (" + marks(readableOrgs().length) + ") and " + alias + ".isactive = 'Y'";
  }

  /**
   * DAL owns this connection: borrow it, never close it.
   *
   * @return the connection of the current DAL transaction
   */
  public static Connection connection() {
    return OBDal.getInstance().getConnection(false);
  }

  /**
   * One request parameter, with the three spellings of "no filter" collapsed to {@code null} so a
   * caller never has to test for them.
   *
   * @param parameters
   *          the handler's parameter map
   * @param key
   *          the parameter name
   * @return the trimmed value, or {@code null} when absent, empty, {@code all} or {@code null}
   */
  public static String param(Map<String, Object> parameters, String key) {
    final Object raw = parameters.get(key);
    if (raw == null) {
      return null;
    }
    final String value = raw.toString().trim();
    return value.isEmpty() || "all".equals(value) || "null".equals(value) ? null : value;
  }

  /**
   * Maps a result set to a JSON array, one object per row, using the given column list.
   *
   * @param rs
   *          the result set, consumed to exhaustion
   * @param cols
   *          the columns to read and where each one lands in JSON
   * @return one JSON object per row
   * @throws Exception
   *           if a column read or a JSON put fails
   */
  public static JSONArray rows(ResultSet rs, Col... cols) throws Exception {
    final JSONArray out = new JSONArray();
    while (rs.next()) {
      final JSONObject row = new JSONObject();
      for (Col col : cols) {
        col.put(rs, row);
      }
      out.put(row);
    }
    return out;
  }

  /**
   * Collects columns into a list, for the callers that assemble a projection conditionally.
   *
   * @param cols
   *          the columns to collect
   * @return a mutable list of the given columns
   */
  public static List<Col> list(Col... cols) {
    final List<Col> out = new ArrayList<>();
    for (Col c : cols) {
      out.add(c);
    }
    return out;
  }

  /** One column of a result set, and how it lands in JSON. */
  public interface Col {

    /**
     * Reads this column from the current row and writes it into the row object.
     *
     * @param rs
     *          the result set, positioned on a row
     * @param row
     *          the JSON object being built for that row
     * @throws Exception
     *           if the read or the put fails
     */
    void put(ResultSet rs, JSONObject row) throws Exception;
  }

  /**
   * A text column. SQL NULL becomes {@code ""}, not JSON null: the client concatenates and
   * measures these, and a null would render as the word "null" in the middle of a label.
   *
   * @param key
   *          the JSON key to write
   * @param column
   *          the result-set column to read
   * @return the column mapping
   */
  public static Col str(String key, String column) {
    return (rs, row) -> row.put(key, rs.getString(column) == null ? "" : rs.getString(column));
  }

  /**
   * A numeric column. SQL NULL becomes JSON null, because zero is a measurement and absence is
   * not -- the difference decides whether a widget draws a bar or an em dash.
   *
   * @param key
   *          the JSON key to write
   * @param column
   *          the result-set column to read
   * @return the column mapping
   */
  public static Col num(String key, String column) {
    return (rs, row) -> {
      final java.math.BigDecimal v = rs.getBigDecimal(column);
      row.put(key, v == null ? JSONObject.NULL : v.doubleValue());
    };
  }

  /**
   * A date column, emitted as {@code yyyy-MM-dd}. The time part is dropped on purpose: it would
   * drag the value through the browser's timezone and move business dates by a day.
   *
   * @param key
   *          the JSON key to write
   * @param column
   *          the result-set column to read
   * @return the column mapping
   */
  public static Col date(String key, String column) {
    return (rs, row) -> {
      final java.sql.Timestamp v = rs.getTimestamp(column);
      row.put(key, v == null ? JSONObject.NULL : v.toLocalDateTime().toLocalDate().toString());
    };
  }

  /**
   * Reference date: the caller's asOf, else the newest datum in scope, else today.
   *
   * This instance's dataset ends in 2021, so a window that computed aging from {@code
   * current_date} would show every document five years overdue and the screen would be lying about
   * the framework rather than about the data. Never call {@code current_date} for a business
   * calculation -- take the reference date from here, and tell the reader where it came from.
   *
   * @param conn
   *          the connection to read the fallbacks on
   * @param requested
   *          the caller's explicit asOf, or {@code null}
   * @param maxDateSql
   *          selects exactly one date column and takes only the scope binds
   * @return {@code {"asOf": "yyyy-MM-dd", "asOfSource": "param"|"data"|"today"}}
   * @throws Exception
   *           if the fallback query fails
   */
  public static JSONObject asOf(Connection conn, String requested, String maxDateSql)
      throws Exception {
    if (requested != null) {
      return new JSONObject().put("asOf", requested).put("asOfSource", "param");
    }
    try (PreparedStatement st = conn.prepareStatement(maxDateSql)) {
      bindScope(st, 1);
      try (ResultSet rs = st.executeQuery()) {
        if (rs.next()) {
          final java.sql.Timestamp newest = rs.getTimestamp(1);
          if (newest != null) {
            return new JSONObject()
                .put("asOf", newest.toLocalDateTime().toLocalDate().toString())
                .put("asOfSource", "data");
          }
        }
      }
    }
    try (PreparedStatement st = conn.prepareStatement("select current_date")) {
      try (ResultSet rs = st.executeQuery()) {
        rs.next();
        return new JSONObject()
            .put("asOf", rs.getTimestamp(1).toLocalDateTime().toLocalDate().toString())
            .put("asOfSource", "today");
      }
    }
  }

  /**
   * {limit, offset} from the request's page/limit, clamped so a hostile page number cannot scan
   * the table.
   *
   * @param parameters
   *          the handler's parameter map; {@code page} is 1-based
   * @return {@code { limit, offset }}
   */
  public static int[] page(Map<String, Object> parameters) {
    final int limit = Math.min(200, Math.max(1, intParam(parameters, "limit", 50)));
    final int page = Math.max(1, intParam(parameters, "page", 1));
    return new int[] { limit, (page - 1) * limit };
  }

  /**
   * Executes a prepared count and returns its first column. The caller binds; only the caller
   * knows the scope.
   *
   * @param st
   *          a statement whose first column is the count, already bound
   * @return the count, or 0 when the result set is empty
   * @throws Exception
   *           if the query fails
   */
  public static long total(PreparedStatement st) throws Exception {
    try (ResultSet rs = st.executeQuery()) {
      return rs.next() ? rs.getLong(1) : 0L;
    }
  }

  /**
   * {@code (?::text is null or (a ilike ? or b ilike ?))} -- one search box over several columns.
   *
   * The {@code ?::text} cast is not decoration: Postgres cannot infer the type of a bare {@code ?}
   * inside {@code is null} and refuses to prepare the statement.
   *
   * @param columns
   *          the columns the search box spans
   * @return the predicate, or {@code (1=1)} when there is nothing to search
   */
  public static String likeClause(String... columns) {
    if (columns == null || columns.length == 0) {
      return "(1=1)";
    }
    final StringBuilder sql = new StringBuilder("(?::text is null or (");
    for (int i = 0; i < columns.length; i++) {
      sql.append(i == 0 ? "" : " or ").append(columns[i]).append(" ilike ?");
    }
    return sql.append("))").toString();
  }

  /**
   * Binds the null-test marker plus one {@code %q%} pattern per column; returns the next free
   * index. A blank query binds NULL everywhere, which leaves the clause inert rather than matching
   * every row through {@code ilike '%%'}.
   *
   * @param st
   *          the statement whose like placeholders are being filled
   * @param from
   *          the index of the null-test marker
   * @param q
   *          the user's search text, possibly blank
   * @param columns
   *          how many columns {@link #likeClause(String...)} rendered
   * @return the next free bind index
   * @throws Exception
   *           if the statement rejects a bind
   */
  public static int bindLike(PreparedStatement st, int from, String q, int columns)
      throws Exception {
    final String text = q == null || q.trim().isEmpty() ? null : q.trim();
    int i = from;
    st.setString(i++, text);
    for (int c = 0; c < columns; c++) {
      st.setString(i++, text == null ? null : "%" + text + "%");
    }
    return i;
  }

  /**
   * The tab that shows {@code tableName} in {@code windowId}, or null. Never hardcode a tab id in
   * JS.
   *
   * This instance's {@code c_order} has six header tabs, and picking the wrong one opens "Return
   * to vendor" for a sales order -- so the tab is resolved from the dictionary, at the lowest tab
   * level and lowest sequence, which is the header the window itself opens on. A miss returns
   * {@code null} and the caller degrades to no drill-down: an unavailable link is a smaller
   * failure than a wrong one.
   *
   * @param conn
   *          the connection to read the dictionary on
   * @param windowId
   *          the window the drill-down targets
   * @param tableName
   *          the table whose tab is wanted, case-insensitive
   * @return the tab id, or {@code null} when the window has no active tab on that table
   * @throws Exception
   *           if the dictionary query fails
   */
  public static String tabFor(Connection conn, String windowId, String tableName)
      throws Exception {
    final String sql = "select t.ad_tab_id from ad_tab t"
        + " join ad_table tb on tb.ad_table_id = t.ad_table_id"
        + " where t.ad_window_id = ? and upper(tb.tablename) = upper(?)"
        + " and t.isactive = 'Y' and tb.isactive = 'Y'"
        + " order by t.tablevel, t.seqno limit 1";
    try (PreparedStatement st = conn.prepareStatement(sql)) {
      st.setString(1, windowId);
      st.setString(2, tableName);
      try (ResultSet rs = st.executeQuery()) {
        return rs.next() ? rs.getString(1) : null;
      }
    }
  }

  /** Parses one numeric parameter, treating garbage and negatives as "not supplied". */
  private static int intParam(Map<String, Object> parameters, String key, int fallback) {
    final String raw = param(parameters, key);
    if (raw == null) {
      return fallback;
    }
    try {
      final int value = Integer.parseInt(raw);
      return value < 0 ? fallback : value;
    } catch (NumberFormatException e) {
      return fallback;
    }
  }
}
