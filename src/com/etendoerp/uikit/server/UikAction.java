package com.etendoerp.uikit.server;

import java.util.Map;

import javax.servlet.http.HttpServletRequest;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.codehaus.jettison.json.JSONObject;
import org.openbravo.client.kernel.BaseActionHandler;
import org.openbravo.client.kernel.KernelConstants;
import org.openbravo.erpCommon.utility.CsrfUtil;

/**
 * Base class for every write reached from a uikit window, and the only sanctioned way to perform
 * one.
 *
 * It exists because KernelServlet and BaseActionHandler do not check the CSRF token -- only
 * DataSourceServlet and DeleteImageActionHandler do -- so an action handler that writes and does
 * not check it itself is a cross-site write waiting to happen. Subclasses cannot forget: the check
 * runs in a final {@code execute} before {@link #run(JSONObject, Map)} is ever called.
 *
 * Every subclass must re-read its target under {@link UikQuery#scopeClause(String)} before
 * mutating it. Fact F6 records that ViewComponent does not consult OBUIAPP_View_Role_Access, so
 * the window the caller came from granted no permission at all: the id in the payload is a claim
 * by the browser, not an authorization, and the only proof that this role may touch that row is a
 * scoped read that finds it.
 *
 * Rejections come back as the error envelope rather than as an exception. BaseActionHandler wraps
 * a throw in an IllegalStateException, and SmartClient's {@code evalResult} would then try to
 * evaluate the servlet error page instead of showing the user a message.
 */
public abstract class UikAction extends BaseActionHandler {

  private static final Logger log = LogManager.getLogger();

  /**
   * The payload key, and the query parameter, carrying the token published as
   * {@code OB.User.csrfToken}.
   */
  private static final String CSRF_KEY = "csrfToken";

  /**
   * Performs the write. Called only after the CSRF token has been verified.
   *
   * @param payload
   *          the decoded request body, empty when the caller sent none
   * @param parameters
   *          the query-string parameters, plus the servlet request and session under the
   *          {@link KernelConstants} keys
   * @return the handler's own result, merged into the success envelope
   * @throws Exception
   *           on any failure; it is logged here and reduced to a generic client message
   */
  protected abstract JSONObject run(JSONObject payload, Map<String, Object> parameters)
      throws Exception;

  /**
   * Verifies the token, decodes the body and wraps whatever {@link #run(JSONObject, Map)} returns.
   *
   * @param parameters
   *          the parameter map built by BaseActionHandler from the query string
   * @param content
   *          the raw request body, {@code null} when empty
   * @return the success or the error envelope, never an exception
   */
  @Override
  protected final JSONObject execute(Map<String, Object> parameters, String content) {
    final JSONObject payload = parse(content);
    if (!hasValidCsrfToken(payload, parameters)) {
      return error("ETUIK_NoCsrf", "This request could not be verified. Reload the window and"
          + " try again.");
    }
    try {
      return success(run(payload, parameters));
    } catch (Exception e) {
      log.error("{} failed: {}", getClass().getName(), e.getMessage(), e);
      return error("ETUIK_Failed", "The operation could not be completed.");
    }
  }

  /**
   * Decodes the body, tolerating both an absent one and a malformed one.
   *
   * A malformed body degrades to an empty object instead of its own error: it cannot carry a valid
   * token either, so the CSRF check that follows rejects it, and reporting the decode failure
   * separately would only tell an attacker which of the two tests they failed.
   */
  private JSONObject parse(String content) {
    if (content == null || content.trim().isEmpty()) {
      return new JSONObject();
    }
    try {
      return new JSONObject(content);
    } catch (Exception e) {
      log.warn("{} received a body that is not JSON", getClass().getName());
      return new JSONObject();
    }
  }

  /**
   * Delegates to core's CsrfUtil, which compares the token against the {@code #CSRF_TOKEN} session
   * attribute.
   *
   * An absent request object or an absent token is a rejection, never a pass: this method returns
   * true only when core positively accepted the token.
   */
  private boolean hasValidCsrfToken(JSONObject payload, Map<String, Object> parameters) {
    final Object request = parameters.get(KernelConstants.HTTP_REQUEST);
    if (!(request instanceof HttpServletRequest)) {
      log.error("{} rejected: no servlet request to read the session token from",
          getClass().getName());
      return false;
    }
    final String token = payload.optString(CSRF_KEY, UikQuery.param(parameters, CSRF_KEY));
    if (token == null || token.trim().isEmpty()) {
      log.error("{} rejected: no CSRF token in the payload or the query string",
          getClass().getName());
      return false;
    }
    try {
      CsrfUtil.checkCsrfToken(token, (HttpServletRequest) request);
      return true;
    } catch (Exception e) {
      log.error("{} rejected: CSRF token check failed", getClass().getName());
      return false;
    }
  }

  /** The handler's own keys, plus the marker that says the write happened. */
  private JSONObject success(JSONObject result) {
    final JSONObject out = result == null ? new JSONObject() : result;
    try {
      out.put("success", true);
    } catch (Exception ignored) {
      return out;
    }
    return out;
  }

  /**
   * The shape uikit.js reads: {@code data.error.message} is rendered, so the message has to be a
   * sentence for a user. The stack trace and the SQL stay in the server log -- a client-facing
   * message that quotes them is a free schema dump.
   */
  private JSONObject error(String code, String message) {
    try {
      return new JSONObject().put("success", false).put("error",
          new JSONObject().put("code", code).put("message", message));
    } catch (Exception ignored) {
      return new JSONObject();
    }
  }
}
