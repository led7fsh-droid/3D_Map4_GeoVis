mapboxgl.accessToken = 'pk.eyJ1IjoibGVkcDA2IiwiYSI6ImNtbWdneDl6YTA4b24yeXBzbmdxZzR0dnoifQ.cjeSuNswcCdVH4kqphMQfw';
const COUNTY_DATA_URL = 'USCounties_FeaturesToJSON.geojson';
const TARGET_STATES = new Set(['Minnesota', 'North Dakota', 'South Dakota']);

function normalizeCoord(coord) {
    // Keep enough precision for clean topology while avoiding floating noise.
    return `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;
}

function edgeKey(a, b) {
    const aKey = normalizeCoord(a);
    const bKey = normalizeCoord(b);
    return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

function parseCoordKey(coordKey) {
    return coordKey.split(',').map(Number);
}

function stitchBoundarySegments(segments) {
    const adjacency = new Map();
    const segmentEnds = new Map();
    const visited = new Set();

    for (const [a, b] of segments) {
        const aKey = normalizeCoord(a);
        const bKey = normalizeCoord(b);
        const segKey = edgeKey(a, b);

        segmentEnds.set(segKey, [aKey, bKey]);

        if (!adjacency.has(aKey)) adjacency.set(aKey, []);
        if (!adjacency.has(bKey)) adjacency.set(bKey, []);
        adjacency.get(aKey).push(segKey);
        adjacency.get(bKey).push(segKey);
    }

    function findUnusedSegment(endpointKey) {
        const touching = adjacency.get(endpointKey) || [];
        for (const segKey of touching) {
            if (!visited.has(segKey)) return segKey;
        }
        return null;
    }

    function extend(line, atEnd) {
        while (true) {
            const endpointKey = atEnd
                ? normalizeCoord(line[line.length - 1])
                : normalizeCoord(line[0]);
            const nextSeg = findUnusedSegment(endpointKey);
            if (!nextSeg) break;

            visited.add(nextSeg);
            const [k1, k2] = segmentEnds.get(nextSeg);
            const nextKey = k1 === endpointKey ? k2 : k1;
            const nextCoord = parseCoordKey(nextKey);

            if (atEnd) {
                line.push(nextCoord);
            } else {
                line.unshift(nextCoord);
            }
        }
    }

    const lines = [];
    for (const [segKey, ends] of segmentEnds.entries()) {
        if (visited.has(segKey)) continue;

        visited.add(segKey);
        const [aKey, bKey] = ends;
        const line = [parseCoordKey(aKey), parseCoordKey(bKey)];

        extend(line, true);
        extend(line, false);

        lines.push(line);
    }

    return lines;
}

function getStateName(props) {
    return (
        props['DonorData$.State'] ||
        props.State ||
        props.STATE_NAME ||
        props.state ||
        null
    );
}

function getRings(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return geometry.coordinates || [];
    if (geometry.type === 'MultiPolygon') {
        return (geometry.coordinates || []).flat();
    }
    return [];
}

function buildStateBoundaryFeatureCollection(geojson) {
    const stateEdgeMaps = new Map();

    for (const feature of geojson.features || []) {
        const props = feature.properties || {};
        const stateName = getStateName(props);
        if (!TARGET_STATES.has(stateName)) continue;

        if (!stateEdgeMaps.has(stateName)) {
            stateEdgeMaps.set(stateName, new Map());
        }

        const edgeMap = stateEdgeMaps.get(stateName);
        const rings = getRings(feature.geometry);

        for (const ring of rings) {
            if (!ring || ring.length < 2) continue;

            for (let i = 0; i < ring.length - 1; i++) {
                const a = ring[i];
                const b = ring[i + 1];
                if (!a || !b || a.length < 2 || b.length < 2) continue;

                const key = edgeKey(a, b);
                edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
            }
        }
    }

    const features = [];
    for (const [stateName, edgeMap] of stateEdgeMaps.entries()) {
        const boundarySegments = [];

        for (const [key, count] of edgeMap.entries()) {
            if (count !== 1) continue;
            const [aStr, bStr] = key.split('|');
            const a = aStr.split(',').map(Number);
            const b = bStr.split(',').map(Number);
            boundarySegments.push([a, b]);
        }

        const stitchedBoundaries = stitchBoundarySegments(boundarySegments);

        features.push({
            type: 'Feature',
            properties: { state: stateName },
            geometry: {
                type: 'MultiLineString',
                coordinates: stitchedBoundaries
            }
        });
    }

    return {
        type: 'FeatureCollection',
        features
    };
}

const STATES_CONFIG = [
    { key: 'Minnesota',    label: 'MN' },
    { key: 'North Dakota', label: 'ND' },
    { key: 'South Dakota', label: 'SD' }
];

const activeStates = new Set(STATES_CONFIG.map(s => s.key));

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [-98.5, 46.5],
    zoom: 5,
    pitch: 50,
    antialias: true
});

function buildCountyFilter() {
    const active = [...activeStates];
    if (active.length === 0) return ['==', ['literal', 'x'], ['literal', 'y']];
    const stateExpr = ['coalesce', ['get', 'DonorData$.State'], ['get', 'State'], ''];
    return ['match', stateExpr, active, true, false];
}

function buildBoundaryFilter() {
    const active = [...activeStates];
    if (active.length === 0) return ['==', ['literal', 'x'], ['literal', 'y']];
    return ['match', ['get', 'state'], active, true, false];
}

const COUNTY_LAYER_IDS = [
    'altruism-spikes',
    'altruism-spikes-side-shadow'
];

const BOUNDARY_LAYER_IDS = [
    'target-state-boundaries-halo',
    'target-state-boundaries-core'
];

const STORYMAP_VIEWS = {
    GLOBAL: {
        camera: { center: [-98.5, 46.5], zoom: 5, pitch: 50, bearing: 0 },
        activeStates: ['Minnesota', 'North Dakota', 'South Dakota'],
        labelsVisible: true
    },
    MN: {
        camera: { center: [-94.5, 46.3], zoom: 6.2, pitch: 55, bearing: 10 },
        activeStates: ['Minnesota'],
        labelsVisible: true
    },
    ND: {
        camera: { center: [-101, 47.5], zoom: 6.2, pitch: 60, bearing: -15 },
        activeStates: ['North Dakota'],
        labelsVisible: true
    },
    SD: {
        camera: { center: [-100.2, 44.4], zoom: 6.2, pitch: 50, bearing: 5 },
        activeStates: ['South Dakota'],
        labelsVisible: true
    },
    COMPARE: {
        camera: { center: [-98.5, 46.5], zoom: 5.2, pitch: 55, bearing: -8 },
        activeStates: ['Minnesota', 'North Dakota', 'South Dakota'],
        labelsVisible: false
    }
};

let labelsVisible = true;
let labelLayerIds = [];

function syncStateButtons() {
    STATES_CONFIG.forEach(({ key, label }) => {
        const btn = document.getElementById(`toggle-${label}`);
        if (!btn) return;
        btn.classList.toggle('active', activeStates.has(key));
    });
}

function setActiveStates(nextStates) {
    activeStates.clear();
    nextStates.forEach((state) => activeStates.add(state));
    syncStateButtons();
    applyStateFilters();
}

function setLabelsVisible(nextVisible) {
    labelsVisible = Boolean(nextVisible);
    const visibility = labelsVisible ? 'visible' : 'none';
    labelLayerIds.forEach((id) => {
        if (map.getLayer(id)) {
            map.setLayoutProperty(id, 'visibility', visibility);
        }
    });

    const labelsBtn = document.getElementById('toggle-labels');
    if (labelsBtn) {
        labelsBtn.classList.toggle('active', labelsVisible);
    }
}

function normalizeStorymapViewName(name) {
    if (!name) return null;
    return String(name).trim().toUpperCase();
}

function applyStorymapView(viewName, options = {}) {
    const normalizedView = normalizeStorymapViewName(viewName);
    if (!normalizedView || !STORYMAP_VIEWS[normalizedView]) return false;

    const preset = STORYMAP_VIEWS[normalizedView];
    const duration = Number.isFinite(options.duration) ? options.duration : 3500;

    if (Array.isArray(preset.activeStates)) {
        setActiveStates(preset.activeStates);
    }

    if (typeof preset.labelsVisible === 'boolean') {
        setLabelsVisible(preset.labelsVisible);
    }

    map.flyTo({
        ...preset.camera,
        essential: true,
        duration
    });

    return true;
}

function getRequestedStorymapView() {
    const url = new URL(window.location.href);
    const fromSearch = url.searchParams.get('view');
    if (fromSearch) return fromSearch;

    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    if (!hash) return null;

    const hashParams = new URLSearchParams(hash);
    if (hashParams.get('view')) {
        return hashParams.get('view');
    }

    if (hash.includes('=')) {
        return null;
    }

    return hash;
}

function handleStorymapRemoteMessage(data) {
    if (!data) return false;

    if (typeof data === 'string') {
        return applyStorymapView(data);
    }

    if (typeof data !== 'object') return false;

    const messageType = data.type || data.action;
    if (messageType && !['storymap-control', 'storymap-view', 'set-view'].includes(messageType)) {
        return false;
    }

    if (data.view && applyStorymapView(data.view, { duration: data.duration })) {
        return true;
    }

    if (Array.isArray(data.activeStates)) {
        setActiveStates(data.activeStates);
    }

    if (typeof data.labelsVisible === 'boolean') {
        setLabelsVisible(data.labelsVisible);
    }

    if (data.camera && typeof data.camera === 'object') {
        map.flyTo({
            ...data.camera,
            essential: true,
            duration: Number.isFinite(data.duration) ? data.duration : 3500
        });
        return true;
    }

    return false;
}

function applyStateFilters() {
    const countyFilter = buildCountyFilter();
    const boundaryFilter = buildBoundaryFilter();
    COUNTY_LAYER_IDS.forEach(id => { if (map.getLayer(id)) map.setFilter(id, countyFilter); });
    BOUNDARY_LAYER_IDS.forEach(id => { if (map.getLayer(id)) map.setFilter(id, boundaryFilter); });
}

map.on('load', async () => {
    const weightedEfficiencyExpr = [
        'coalesce',
        ['to-number', ['get', 'DonorData$.Weighted_Efficiency']],
        ['to-number', ['get', 'Weighted_Efficiency']],
        0
    ];

    const pctClassExpr = [
        'coalesce',
        ['to-number', ['get', 'DonorData$.Pct_Class']],
        ['to-number', ['get', 'Pct_Class']],
        -1
    ];

    map.addSource('altruism-data', {
        type: 'geojson',
        data: COUNTY_DATA_URL
    });

    const countyGeojson = await fetch(COUNTY_DATA_URL).then((res) => res.json());
    const stateBoundaryGeojson = buildStateBoundaryFeatureCollection(countyGeojson);

    map.addSource('state-boundaries-generated', {
        type: 'geojson',
        data: stateBoundaryGeojson
    });

    map.setLight({
        anchor: 'map',
        color: '#ffffff',
        intensity: 0.6,
        position: [1, 90, 20]
    });

    map.addLayer({
        id: 'sky',
        type: 'sky',
        paint: {
            'sky-type': 'atmosphere',
            'sky-atmosphere-sun': [90, 20],
            'sky-atmosphere-sun-intensity': 6
        }
    });

    map.addLayer({
        id: 'altruism-spikes',
        type: 'fill-extrusion',
        source: 'altruism-data',
        paint: {
            'fill-extrusion-color': [
                'match', pctClassExpr,
                1, '#deebf7',
                2, '#9ecae1',
                3, '#6baed6',
                4, '#2171b5',
                5, '#08306b',
                '#888888'
            ],
            'fill-extrusion-height': [
                'interpolate', ['linear'], weightedEfficiencyExpr,
                0, 0,
                700, 2000,
                1300, 12000,
                1800, 28000,
                2400, 52000,
                3200, 90000,
                3900, 140000
            ],
            'fill-extrusion-base': 0,
            'fill-extrusion-opacity': 0.9,
            'fill-extrusion-vertical-gradient': true
        }
    });

    map.addLayer({
        id: 'altruism-spikes-side-shadow',
        type: 'fill-extrusion',
        source: 'altruism-data',
        paint: {
            'fill-extrusion-height': [
                'interpolate', ['linear'], weightedEfficiencyExpr,
                0, 0,
                700, 2000,
                1300, 12000,
                1800, 28000,
                2400, 52000,
                3200, 90000,
                3900, 140000
            ],
            'fill-extrusion-base': 0,
            'fill-extrusion-color': '#000000',
            'fill-extrusion-opacity': 0.1
        }
    });

    map.addLayer({
        id: 'target-state-boundaries-halo',
        type: 'line',
        source: 'state-boundaries-generated',
        paint: {
            'line-color': '#0b1220',
            'line-width': [
                'interpolate',
                ['linear'],
                ['zoom'],
                4, 5,
                7, 9,
                10, 14
            ],
            'line-blur': 1,
            'line-opacity': 0.65,
            'line-emissive-strength': 0.5
        },
        layout: {
            'line-cap': 'round',
            'line-join': 'round'
        }
    });

    map.addLayer({
        id: 'target-state-boundaries-core',
        type: 'line',
        source: 'state-boundaries-generated',
        paint: {
            'line-color': '#f8fbff',
            'line-width': [
                'interpolate',
                ['linear'],
                ['zoom'],
                4, 2.2,
                7, 3.6,
                10, 5.2
            ],
            'line-opacity': 1,
            'line-emissive-strength': 1
        },
        layout: {
            'line-cap': 'round',
            'line-join': 'round'
        }
    });

    const hoverPopup = new mapboxgl.Popup({
        closeButton: false,
        closeOnClick: false,
        className: 'altruism-popup'
    });

    map.on('mousemove', 'altruism-spikes', (e) => {
        const feature = e.features && e.features[0];
        if (!feature) return;

        const props = feature.properties || {};
        const countyName =
            props['DonorData$.County_Name'] ||
            props.NAME ||
            props.COUNTY ||
            props.County ||
            props.county ||
            'Unknown County';
        const rawEfficiency = props['DonorData$.Weighted_Efficiency'] ?? props.Weighted_Efficiency;
        const efficiencyScore = rawEfficiency != null ? Number(rawEfficiency).toFixed(2) : 'N/A';

        const pctClassRaw = props['DonorData$.Pct_Class'] ?? props.Pct_Class;
        const pctClassLabels = { 1: 'Very Low', 2: 'Low', 3: 'Average', 4: 'High', 5: 'Exceptional' };
        const communityEngagement = pctClassLabels[Number(pctClassRaw)] ?? 'N/A';

        const mapLabel =
            props['DonorData$.Map_Label'] ?? props.Map_Label ?? countyName;

        map.getCanvas().style.cursor = 'pointer';

        hoverPopup
            .setLngLat(e.lngLat)
            .setHTML(
                `<div class="popup-card">
                    <div class="popup-title">${mapLabel}</div>
                    <div class="popup-row"><span>Efficiency Score</span><strong>${efficiencyScore}</strong></div>
                    <div class="popup-row"><span>Community Engagement</span><strong>${communityEngagement}</strong></div>
                </div>`
            )
            .addTo(map);
    });

    map.on('mouseleave', 'altruism-spikes', () => {
        map.getCanvas().style.cursor = '';
        hoverPopup.remove();
    });

    // Wire up state toggle buttons
    STATES_CONFIG.forEach(({ key, label }) => {
        const btn = document.getElementById(`toggle-${label}`);
        if (!btn) return;
        btn.addEventListener('click', () => {
            if (activeStates.has(key)) {
                activeStates.delete(key);
                btn.classList.remove('active');
            } else {
                activeStates.add(key);
                btn.classList.add('active');
            }
            applyStateFilters();
        });
    });

    // Wire up basemap labels toggle
    labelLayerIds = map.getStyle().layers
        .filter(l => l.type === 'symbol')
        .map(l => l.id);

    const labelsBtn = document.getElementById('toggle-labels');
    if (labelsBtn) {
        labelsBtn.addEventListener('click', () => {
            setLabelsVisible(!labelsVisible);
        });
    }

    window.addEventListener('message', (event) => {
        handleStorymapRemoteMessage(event.data);
    });

    const syncFromUrl = () => {
        const requestedView = getRequestedStorymapView();
        if (requestedView) {
            applyStorymapView(requestedView);
        }
    };

    window.addEventListener('hashchange', syncFromUrl);
    window.addEventListener('popstate', syncFromUrl);

    window.storyMapControls = {
        views: STORYMAP_VIEWS,
        applyView: applyStorymapView,
        apply: handleStorymapRemoteMessage
    };

    syncStateButtons();
    setLabelsVisible(labelsVisible);
    syncFromUrl();
});