// TV2 Nord Event Display JavaScript

class EventDisplay {
  constructor() {
    this.API_BASE = window.location.origin;
    this.lastDataSnapshot = "";
    this.connectionRetries = 0;
    this.MAX_RETRIES = 5;
    this.updateInterval = null;
    this.svgLoaded = false;

    this.init();
  }

  init() {
    console.log("🚀 Initializing TV2 Nord Event Display");

    // Wait for DOM to be ready
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.start());
    } else {
      this.start();
    }
  }

  start() {
    this.loadSVG();
    this.setupEventListeners();
    this.startAutoUpdate();
  }

  setupEventListeners() {
    // Handle page visibility changes
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.loadData();
        this.startAutoUpdate();
      } else {
        this.stopAutoUpdate();
      }
    });

    // Handle online/offline events
    window.addEventListener("online", () => {
      this.connectionRetries = 0;
      this.loadData();
      this.startAutoUpdate();
      this.updateConnectionStatus(true);
    });

    window.addEventListener("offline", () => {
      this.stopAutoUpdate();
      this.updateConnectionStatus(false);
    });
  }

  async loadSVG() {
    console.log("📍 Loading SVG map...");

    try {
      const response = await fetch("assets/nordjylland.svg");

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const svgText = await response.text();
      const svgContainer = document.getElementById("svgContainer");

      if (svgContainer) {
        svgContainer.innerHTML = svgText;
        this.svgLoaded = true;
        console.log("✅ SVG map loaded successfully");

        // Load data after SVG is ready
        this.loadData();
      }
    } catch (error) {
      console.error("❌ Error loading SVG:", error);
      const svgContainer = document.getElementById("svgContainer");
      if (svgContainer) {
        svgContainer.innerHTML = `<p>Fejl ved indlæsning af kort: ${error.message}</p>`;
      }
    }
  }

  startAutoUpdate() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    this.updateInterval = setInterval(() => this.loadData(), 30000); // Every 30 seconds
  }

  stopAutoUpdate() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  async loadData() {
    if (!this.svgLoaded) {
      console.log("⏳ Waiting for SVG to load before fetching data");
      return;
    }

    try {
      const response = await fetch(`${this.API_BASE}/api/stats`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const stats = await response.json();
      const newSnapshot = JSON.stringify(stats);

      // Check if data has changed
      const hasChanged = newSnapshot !== this.lastDataSnapshot;
      this.lastDataSnapshot = newSnapshot;

      this.updateDisplay(stats, hasChanged);
      this.updateConnectionStatus(true);
      this.connectionRetries = 0;
    } catch (error) {
      console.error("❌ Error loading data:", error);
      this.handleConnectionError();
    }
  }

  handleConnectionError() {
    this.connectionRetries++;
    this.updateConnectionStatus(false);

    if (this.connectionRetries >= this.MAX_RETRIES) {
      console.log("⚠️ Max retries reached, pausing auto-updates");
      this.stopAutoUpdate();

      // Retry after 1 minute
      setTimeout(() => {
        console.log("🔄 Retrying connection...");
        this.connectionRetries = 0;
        this.startAutoUpdate();
      }, 60000);
    } else {
      // Retry with exponential backoff
      const retryDelay = Math.min(
        1000 * Math.pow(2, this.connectionRetries),
        30000
      );
      console.log(`⏰ Retrying in ${retryDelay / 1000} seconds...`);
      setTimeout(() => this.loadData(), retryDelay);
    }
  }

  updateConnectionStatus(isOnline) {
    const indicator = document.getElementById("statusIndicator");
    const statusText = document.getElementById("statusText");

    if (indicator && statusText) {
      if (isOnline) {
        indicator.className = "status-indicator status-online";
        statusText.textContent = "Live";
      } else {
        indicator.className = "status-indicator status-offline";
        statusText.textContent = "Offline";
      }
    }
  }

  updateDisplay(stats, animate = false) {
    console.log("📊 Updating display with new data");

    // Update today's total
    this.updateNumber("todayTotal", stats.todayTotal, animate);

    // Update top kommune
    this.updateTopKommune(stats.topKommune, animate);

    // Update map and kommun list
    this.updateMap(stats.kommuneStats, animate);
    this.updateTopKommuneList(stats.kommuneStats, animate);
    this.updateLastUpdated();
  }

  updateNumber(elementId, newValue, animate) {
    const element = document.getElementById(elementId);
    if (!element) return;

    const oldValue = parseInt(element.textContent) || 0;

    if (newValue !== oldValue) {
      if (animate && newValue > oldValue) {
        element.classList.add("animated-count");
        setTimeout(() => element.classList.remove("animated-count"), 800);
        this.animateCounter(element, oldValue, newValue, 800);
      } else {
        element.textContent = newValue;
      }
    }
  }

  animateCounter(element, start, end, duration) {
    const startTime = performance.now();

    const updateCounter = (currentTime) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const current = Math.floor(start + (end - start) * progress);

      element.textContent = current;

      if (progress < 1) {
        requestAnimationFrame(updateCounter);
      }
    };

    requestAnimationFrame(updateCounter);
  }

  updateTopKommune(topKommune, animate) {
    const element = document.getElementById("topKommune");
    if (!element) return;

    if (topKommune !== "Ingen data") {
      element.textContent = topKommune;
      if (animate) {
        element.classList.add("pulse");
        setTimeout(() => element.classList.remove("pulse"), 2000);
      }
    } else {
      element.textContent = "Ingen data";
    }
  }

  updateMap(kommuneStats, animate) {
    console.log("🗺️ Updating map with kommune stats");

    if (!kommuneStats || typeof kommuneStats !== "object") {
      console.warn("⚠️ Invalid kommune stats data");
      return;
    }

    const maxCount = Math.max(...Object.values(kommuneStats), 1);

    // Clear existing number labels
    const numberOverlay = document.getElementById("numberOverlay");
    if (numberOverlay) {
      numberOverlay.innerHTML = "";
    }

    // Update each kommune
    document.querySelectorAll("[data-kommune]").forEach((element) => {
      const kommune = element.getAttribute("data-kommune");
      const count = kommuneStats[kommune] || 0;
      const intensity = count / maxCount;

      // Calculate color based on visitor count
      let color = "#e8f5e8"; // Light green default

      if (count > 0) {
        const hue = 120; // Green hue
        const saturation = 60 + intensity * 35; // 60-95%
        const lightness = 85 - intensity * 45; // 85-40%
        color = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
      }

      // Update all polygons in this kommune group
      const polygons = element.querySelectorAll("polygon");
      polygons.forEach((polygon) => {
        polygon.style.fill = color;
      });

      if (animate && count > 0) {
        element.classList.add("pulse");
        setTimeout(() => element.classList.remove("pulse"), 2000);
      }

      // Add count label if there are visitors
      if (count > 0) {
        this.addMapCountLabel(kommune, count, element);
      }
    });
  }

  addMapCountLabel(kommune, count, kommuneElement) {
    const polygons = kommuneElement.querySelectorAll("polygon");
    if (polygons.length === 0) {
      console.warn(`⚠️ No polygons found for ${kommune}`);
      return;
    }

    // Calculate combined bounding box
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;

    polygons.forEach((polygon) => {
      const bbox = polygon.getBBox();
      minX = Math.min(minX, bbox.x);
      minY = Math.min(minY, bbox.y);
      maxX = Math.max(maxX, bbox.x + bbox.width);
      maxY = Math.max(maxY, bbox.y + bbox.height);
    });

    // Calculate center
    const svgCenterX = (minX + maxX) / 2;
    const svgCenterY = (minY + maxY) / 2;

    // Get positioning elements
    const mapContainer = document.getElementById("mapContainer");
    const svgContainer = document.getElementById("svgContainer");
    const svg = svgContainer?.querySelector("svg");

    if (!svg || !mapContainer) return;

    // Calculate screen positions
    const svgRect = svg.getBoundingClientRect();
    const containerRect = mapContainer.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;

    const scaleX = svgRect.width / viewBox.width;
    const scaleY = svgRect.height / viewBox.height;

    const containerX = svgRect.left - containerRect.left + svgCenterX * scaleX;
    const containerY = svgRect.top - containerRect.top + svgCenterY * scaleY;

    // Create and position number label
    const numberLabel = document.createElement("div");
    numberLabel.className = "number-label";
    numberLabel.textContent = count;
    numberLabel.style.left = containerX + "px";
    numberLabel.style.top = containerY + "px";

    const numberOverlay = document.getElementById("numberOverlay");
    if (numberOverlay) {
      numberOverlay.appendChild(numberLabel);
    }
  }

  updateTopKommuneList(kommuneStats, animate) {
    const container = document.getElementById("topKommuneList");
    if (!container) return;

    // Sort kommuner by count
    const sortedKommuner = Object.entries(kommuneStats)
      .filter(([, count]) => count > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);

    container.innerHTML = "";

    if (sortedKommuner.length === 0) {
      container.innerHTML =
        '<div style="text-align: center; opacity: 0.7; padding: 20px;">Ingen registreringer endnu</div>';
      return;
    }

    sortedKommuner.forEach(([kommune, count], index) => {
      const item = document.createElement("div");
      item.className = "kommune-item";

      const name = document.createElement("span");
      name.textContent = `${index + 1}. ${kommune}`;

      const countSpan = document.createElement("span");
      countSpan.className = "kommune-count";
      countSpan.textContent = count;

      if (animate) {
        countSpan.classList.add("animated-count");
        setTimeout(() => countSpan.classList.remove("animated-count"), 800);
      }

      item.appendChild(name);
      item.appendChild(countSpan);
      container.appendChild(item);
    });
  }

  updateLastUpdated() {
    const element = document.getElementById("lastUpdated");
    if (!element) return;

    const now = new Date();
    const timeString = now.toLocaleTimeString("da-DK", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    element.textContent = `Sidste opdatering: ${timeString}`;
  }
}

// Initialize when page loads
new EventDisplay();
