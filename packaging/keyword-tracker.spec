# PyInstaller build for the desktop app.
#   Windows: one file, dist/KeywordTracker.exe, with a small console window ("keep this open").
#   macOS:   dist/Keyword Tracker.app, no console; quit from the page's Quit button.
# Build from the repo root:  pyinstaller packaging/keyword-tracker.spec --noconfirm
import os
import sys

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
ICON = os.path.join(SPECPATH, "icon.png")  # converted to .ico/.icns by Pillow at build time
MAC = sys.platform == "darwin"

a = Analysis(
    [os.path.join(SPECPATH, "launcher.py")],
    pathex=[ROOT],
    datas=[
        (os.path.join(ROOT, "tracker", "static"), os.path.join("tracker", "static")),
        (os.path.join(ROOT, "config.toml"), "."),
    ],
    hiddenimports=["tracker.web", "tracker.pipeline", "tracker.suggest", "tracker.trends", "waitress"],
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "notebook", "scipy"],
    noarchive=False,
)
pyz = PYZ(a.pure)

if MAC:
    exe = EXE(
        pyz, a.scripts, [],
        exclude_binaries=True,
        name="Keyword Tracker",
        console=False,
        icon=ICON,
        upx=False,
    )
    coll = COLLECT(exe, a.binaries, a.datas, name="Keyword Tracker", upx=False)
    app = BUNDLE(
        coll,
        name="Keyword Tracker.app",
        icon=ICON,
        bundle_identifier="com.outlandfabworks.keywordtracker",
        info_plist={
            "CFBundleDisplayName": "Keyword Tracker",
            "CFBundleShortVersionString": os.environ.get("KWT_VERSION", "0.0.0"),
            "NSHighResolutionCapable": True,
            "LSUIElement": True,  # background app: no Dock icon; the browser page is the UI
        },
    )
else:
    exe = EXE(
        pyz, a.scripts, a.binaries, a.datas, [],
        name="KeywordTracker",
        console=True,
        icon=ICON,
        upx=False,
    )
