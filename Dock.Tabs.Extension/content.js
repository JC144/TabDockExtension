// Entry point. Every file listed before this one in the manifest's content_scripts
// runs as a classic script in the same isolated world, so their top-level
// classes are in scope here. No ES module import(): that would require the
// files to be web-accessible, i.e. readable (and fingerprintable) by any site.
new Main();
