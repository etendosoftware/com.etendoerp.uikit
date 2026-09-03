package org.openbravo.client.kernel;

import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Drives the kernel's own JSMin from the command line so the verification harness minifies
 * with exactly the code that runs in production, instead of an approximation of it.
 *
 * Lives in the kernel package because JSMin is package-private; compiled against the core
 * source tree, never shipped in the module's web resources.
 */
public class JSMinRunner {
  public static void main(String[] args) throws Exception {
    if (args.length < 2) {
      System.err.println("usage: JSMinRunner <in.js> <out.js>");
      System.exit(2);
    }
    try (InputStream in = new FileInputStream(args[0]);
        OutputStream out = new FileOutputStream(args[1])) {
      new JSMin(in, out).jsmin();
    }
  }
}
