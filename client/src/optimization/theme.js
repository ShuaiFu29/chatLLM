(function () {
  try {
    var storage = localStorage.getItem('theme-storage');
    var state = storage ? JSON.parse(storage).state : null;
    var primaryColor = (state && state.primaryColor) || '#2563eb';
    var baseColor = (state && state.baseColor) || '#111827';
    var root = document.documentElement;

    // Helper to expand 3-digit hex to 6-digit
    function expandHex(hex) {
      hex = hex.replace('#', '');
      if (hex.length === 3) {
        return '#' + hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      }
      return '#' + hex;
    }

    primaryColor = expandHex(primaryColor);
    baseColor = expandHex(baseColor);

    function adjustColorBrightness(hex, percent) {
      hex = hex.replace('#', '');
      var num = parseInt(hex, 16);
      var amt = Math.round(2.55 * percent);
      var R = (num >> 16) + amt;
      var G = (num >> 8 & 0x00FF) + amt;
      var B = (num & 0x0000FF) + amt;
      return '#' + (0x1000000 + (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 + (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 + (B < 255 ? B < 1 ? 0 : B : 255)).toString(16).slice(1);
    }

    function isColorDark(hex) {
      hex = hex.replace('#', '');
      var rgb = parseInt(hex, 16);
      var r = (rgb >> 16) & 0xff;
      var g = (rgb >> 8) & 0xff;
      var b = (rgb >> 0) & 0xff;
      var luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return luma < 128;
    }

    // Apply critical styles immediately
    root.style.setProperty('--color-primary', primaryColor);
    root.style.setProperty('--color-primary-hover', adjustColorBrightness(primaryColor, -10));
    root.style.setProperty('--color-primary-light', adjustColorBrightness(primaryColor, 40));
    root.style.setProperty('--color-bg-base', baseColor);

    // Update meta theme-color for mobile browsers
    var metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', baseColor);
    }

    if (isColorDark(baseColor)) {
      root.style.setProperty('--color-bg-sidebar', adjustColorBrightness(baseColor, 5));
      root.style.setProperty('--color-bg-surface', adjustColorBrightness(baseColor, 10));
      root.style.setProperty('--color-text-main', '#ffffff');
      root.style.setProperty('--color-text-muted', '#9ca3af');
      root.style.setProperty('--color-border', adjustColorBrightness(baseColor, 15));
    } else {
      root.style.setProperty('--color-bg-sidebar', adjustColorBrightness(baseColor, -5));
      root.style.setProperty('--color-bg-surface', '#ffffff');
      root.style.setProperty('--color-text-main', '#111827');
      root.style.setProperty('--color-text-muted', '#4b5563');
      root.style.setProperty('--color-border', adjustColorBrightness(baseColor, -15));
    }

    console.log('Theme initialized from storage:', { primaryColor, baseColor });
  } catch (e) {
    console.error('Theme init failed', e);
  }
})();
