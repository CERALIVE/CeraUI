# 📸 CeraUI Screenshots

Visual documentation of the CeraUI interface across desktop and mobile viewports with dark/light theme support.

---

## 🖥️ Desktop (1920×1080)

### Dark Theme

| **General** | **Network** |
|:-----------:|:-----------:|
| ![General Dark](screenshots/desktop/dark/general.png) | ![Network Dark](screenshots/desktop/dark/network.png) |

| **Streaming** | **Advanced** |
|:-------------:|:------------:|
| ![Streaming Dark](screenshots/desktop/dark/streaming.png) | ![Advanced Dark](screenshots/desktop/dark/advanced.png) |

| **DevTools** |
|:------------:|
| ![DevTools Dark](screenshots/desktop/dark/devtools.png) |

### Light Theme

| **General** | **Network** |
|:-----------:|:-----------:|
| ![General Light](screenshots/desktop/light/general.png) | ![Network Light](screenshots/desktop/light/network.png) |

| **Streaming** | **Advanced** |
|:-------------:|:------------:|
| ![Streaming Light](screenshots/desktop/light/streaming.png) | ![Advanced Light](screenshots/desktop/light/advanced.png) |

| **DevTools** |
|:------------:|
| ![DevTools Light](screenshots/desktop/light/devtools.png) |

---

## 📱 Mobile (430×932)

### Dark Theme

| **General** | **Network** | **Streaming** | **Advanced** | **DevTools** |
|:-----------:|:-----------:|:-------------:|:------------:|:------------:|
| ![Mobile General Dark](screenshots/mobile/dark/general.png) | ![Mobile Network Dark](screenshots/mobile/dark/network.png) | ![Mobile Streaming Dark](screenshots/mobile/dark/streaming.png) | ![Mobile Advanced Dark](screenshots/mobile/dark/advanced.png) | ![Mobile DevTools Dark](screenshots/mobile/dark/devtools.png) |

### Light Theme

| **General** | **Network** | **Streaming** | **Advanced** | **DevTools** |
|:-----------:|:-----------:|:-------------:|:------------:|:------------:|
| ![Mobile General Light](screenshots/mobile/light/general.png) | ![Mobile Network Light](screenshots/mobile/light/network.png) | ![Mobile Streaming Light](screenshots/mobile/light/streaming.png) | ![Mobile Advanced Light](screenshots/mobile/light/advanced.png) | ![Mobile DevTools Light](screenshots/mobile/light/devtools.png) |

---

## 🌐 Offline Mode (PWA)

| **Dark** | **Light** |
|:--------:|:---------:|
| ![Offline Dark](screenshots/features/offline-dark.png) | ![Offline Light](screenshots/features/offline-light.png) |

---

## 📊 Summary

**22 screenshots total**: 10 desktop + 10 mobile + 2 offline states

---

## ⚙️ How Screenshots Are Generated

Screenshots are captured automatically using the built-in DevTools screenshot utility with html-to-image.

**Folder Structure**
```
screenshots/
├── desktop/
│   ├── dark/
│   └── light/
├── mobile/
│   ├── dark/
│   └── light/
└── features/
    ├── offline-dark.png
    └── offline-light.png
```

> ⚠️ **Note**: Some UI elements (particularly header components like the language selector and theme toggle) may appear slightly different compared to the live application. This is due to the html-to-image library rendering content in isolated iframes, which can affect certain CSS positioning and responsive behaviors.
