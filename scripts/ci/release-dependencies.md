## 📦 Dependency Chain

Installing `ceralive-device` will automatically pull in all dependencies:

```
srt (SRT library with bonding)
gstlibuvcsrc ─────┤
                  │
                  └── ceralive-device (this package)
                        ├── Depends: cerastream
                        ├── Depends: network-manager (nmcli)
                        ├── Depends: modemmanager (mmcli)
                        └── Depends: mobile-broadband-provider-info (APN database)
```
