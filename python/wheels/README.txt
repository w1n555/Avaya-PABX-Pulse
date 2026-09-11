Offline pip wheels for Avaya PABX Pulse (Windows x64).
Python 3.11 and 3.12. You install Python yourself; install.bat does:

  pip install --no-index --find-links=python\wheels setuptools wheel paramiko python-dotenv
  pip install --no-index --no-build-isolation --find-links=python\wheels -e vendor\avaya-ossi

No PyPI / CDN required when this folder is present.
