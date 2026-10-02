# Entry point for the PyInstaller desktop build (see keyword-tracker.spec).
import sys

from tracker.desktop import main

sys.exit(main())
