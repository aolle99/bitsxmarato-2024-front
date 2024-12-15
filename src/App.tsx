import {useEffect, useState} from 'react';
import {Map} from 'react-map-gl/maplibre';
import DeckGL from '@deck.gl/react';
import {GeoJsonLayer} from '@deck.gl/layers';
import {scaleLinear, scaleThreshold} from 'd3-scale';

import type {MapViewState} from '@deck.gl/core';
import './App.css'
import {Backdrop, Box, Button, CircularProgress} from "@mui/material";
import {DatePicker, LocalizationProvider, TimePicker} from "@mui/x-date-pickers";
import {AdapterDateFns} from "@mui/x-date-pickers/AdapterDateFnsV3";
import {Color, HeatmapLayer} from "deck.gl";
import {Feature, LineString, MultiLineString} from 'geojson';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopCircleIcon from '@mui/icons-material/StopCircle';


const INITIAL_MAP_CONFIGURATION: MapViewState = {
  latitude: 41.38922055290922,
  longitude: 2.113531600484349,
  zoom: 15,
  minZoom: 14,
  maxZoom: 22,
};

const INITIAL_VIEW_STATE: viewStateType = {
  coordinates: {
    latitude: INITIAL_MAP_CONFIGURATION.latitude,
    longitude: INITIAL_MAP_CONFIGURATION.longitude,
  },
  zoom: INITIAL_MAP_CONFIGURATION.zoom,
  viewport: {
    width: 0,
    height: 0,
  },
  visibleArea: 1000,
}

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';

type RoadProperties = {
  state: string;
  type: string;
  id: string;
  name: string;
  length: number;
};

type viewStateType = {
  coordinates: {
    latitude: number;
    longitude: number;
  };
  zoom: number;
  viewport: {
    width: number;
    height: number;
  };
  visibleArea: number;
}

type DataPoint = [longitude: number, latitude: number, count: number];

type Road = Feature<LineString | MultiLineString, RoadProperties>;

export const COLOR_SCALE = scaleThreshold<number, Color>()
  .domain([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])
  .range([
    [26, 152, 80],
    [102, 189, 99],
    [166, 217, 106],
    [217, 239, 139],
    [255, 255, 191],
    [254, 224, 139],
    [253, 174, 97],
    [244, 109, 67],
    [215, 48, 39],
    [168, 0, 0]
  ]);

const WIDTH_SCALE = scaleLinear().clamp(true).domain([0, 0.5]).range([10, 20]);


function calculateVisibleArea(latitude: number, zoom: number, viewportWidth: number, viewportHeight: number): number {
  // Constante de la circunferencia terrestre en metros (Web Mercator)
  const EARTH_CIRCUMFERENCE = 40075016.686;

  // Tamaño de un píxel en metros para la latitud y el nivel de zoom
  const metersPerPixel = (Math.cos(latitude * Math.PI / 180) * EARTH_CIRCUMFERENCE) / (256 * Math.pow(2, zoom));

  // Ancho y alto visibles en metros
  const widthInMeters = metersPerPixel * viewportWidth;
  const heightInMeters = metersPerPixel * viewportHeight;

  return parseInt((Math.min(widthInMeters, heightInMeters) * 0.3).toString());
}

function getLineCenter(line: number[][]): [number, number] {
  // Sencilla implementación para el cálculo del punto medio
  const totalPoints = line.length;

  if (totalPoints < 2) {
    throw new Error("La línea debe tener al menos dos puntos.");
  }

  const start = line[0]; // Primer punto: [longitude, latitude]
  const end = line[totalPoints - 1]; // Último punto: [longitude, latitude]

  // Cálculo del punto intermedio entre start y end
  const midLongitude = (start[0] + end[0]) / 2;
  const midLatitude = (start[1] + end[1]) / 2;

  return [midLongitude, midLatitude];
}

function getMultiLineCenter(multiLine: number[][][]): [number, number] {
  let totalLength = 0;
  const accumulatedCenter = [0, 0];

  for (const line of multiLine) {
    if (line.length < 2) continue; // Saltar líneas inválidas

    const [startLon, startLat] = line[0]; // Primer punto
    const [endLon, endLat] = line[line.length - 1]; // Último punto

    // Cálculo del punto intermedio de esta línea
    const lineCenter = [(startLon + endLon) / 2, (startLat + endLat) / 2];

    accumulatedCenter[0] += lineCenter[0];
    accumulatedCenter[1] += lineCenter[1];
    totalLength++;
  }

  // Retorna el promedio de los centros de línea acumulados
  return [accumulatedCenter[0] / totalLength, accumulatedCenter[1] / totalLength];
}



function MapVisualizer({
                         date,
    playing,
                         mapStyle = MAP_STYLE,
                       }: {
  date: Date;
  playing: boolean;
  mapStyle?: string;
}) {
  const [airQuality, setAirQuality] = useState<DataPoint[] | undefined>(undefined);
  const [roads, setRoads] = useState(undefined);
  const [viewState, setViewState] = useState<viewStateType>(INITIAL_VIEW_STATE);
  const [isLoading, setIsLoading] = useState(false);
  const [nearestPointValue, setNearestPointValue] = useState<{key: number} | undefined>(undefined);

  // Función para recargar los datos usando lat y lon
  const reloadData = async (latitude: number, longitude: number, distance: number) => {

    setIsLoading(true);

    const [newAirQuality, newRoads] = await Promise.all([
      fetch(
        `http://localhost:8000/airquality?lat=${latitude}&lon=${longitude}&distancia=${distance}&date=${date.toISOString()}`
      ).then((response) => response.json()),
      fetch(
        `http://localhost:8000/roads?lat=${latitude}&lon=${longitude}&distancia=${distance}`
      ).then((response) => response.json()),
    ]);

   // recorrer todos los puntos de roads y calcular el valor de la calidad del aire más cercano y guardarlo en un array
    if (!newAirQuality || !newRoads) {
      setIsLoading(false);
      return;
    }
    const nearest_tmp = {}
    newRoads.features.forEach((road: Road) => {
      let center: [number, number] = [0, 0];

      // Calculamos el centro según el tipo
      if (road.geometry.type === "LineString") {
        center = getLineCenter(road.geometry.coordinates);
      } else if (road.geometry.type === "MultiLineString") {
        center = getMultiLineCenter(road.geometry.coordinates);
      }

      // Obtenemos el valor más cercano y lo añadimos al Map
      const nearestPoint = getNearestPointValue(center[1], center[0], newAirQuality);
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      nearest_tmp[road.id] = nearestPoint;
    });
    setNearestPointValue(nearest_tmp);

    setAirQuality(newAirQuality);
    setRoads(newRoads);
    setIsLoading(false);
  };

  // Establece los datos iniciales al montar el componente
  useEffect(() => {
    reloadData(viewState.coordinates.latitude, viewState.coordinates.longitude, viewState.visibleArea);
  }, [viewState, date]);

  const getNearestPointValue = (latitude: number, longitude: number, newAirQuality: DataPoint[]): number => {
    if (!newAirQuality || newAirQuality.length === 0) return 0;

    // Inicializamos variables para distancia mínima y el índice asociado
    let minDistance = Infinity;
    let minIndex = -1;

    for (let i = 0; i < newAirQuality.length; i++) {
      const point = newAirQuality[i];
      const dx = point[0] - latitude;
      const dy = point[1] - longitude;

      const squaredDistance = dx * dx + dy * dy;

      if (squaredDistance < minDistance) {
        minDistance = squaredDistance;
        minIndex = i;
      }
    }
    return minIndex !== -1 ? newAirQuality[minIndex][2] : 0;
  };


  const getLineColor = (feature: Road): Color => {
    if (!nearestPointValue) return [200, 200, 200];
    return COLOR_SCALE(nearestPointValue[feature.id]);
  }

  const getLineWidth = (feature: Road): number => {
    if (!nearestPointValue) return 0.5;
    return WIDTH_SCALE(nearestPointValue[feature.id]);
  }

  const layers = [
    new GeoJsonLayer<RoadProperties>({
      id: "geojson",
      data: roads,
      lineWidthMinPixels: 0.5,
      getLineColor: getLineColor,
      getLineWidth: getLineWidth,
      pickable: true,

      updateTriggers: {
        getLineColor: {date},
        getLineWidth: {date},
      },

      transitions: {
        getLineColor: 1000,
        getLineWidth: 1000,
      },
    }),
    new HeatmapLayer<DataPoint>({
      data: airQuality,
      id: 'heatmap-layer',
      pickable: false,
      getPosition: d => [d[1], d[0]],
      getWeight: d => d[2],
      intensity: 0.5,
      threshold: 0.03,
      radiusPixels: 50,
      opacity: 0.15,
      //colorDomain: [0,0.001]
    })
  ];

  return airQuality ? (
    <>
      <Backdrop
        sx={(theme) => ({color: '#fff', zIndex: theme.zIndex.drawer + 1})}
        open={isLoading && !playing}
      >
        <CircularProgress color="inherit"/>
      </Backdrop>
      <DeckGL
        layers={layers}
        pickingRadius={5}
        initialViewState={INITIAL_MAP_CONFIGURATION}
        controller={!playing}
        onDragEnd={(event) => {
          if (!event.coordinate || !event.viewport || !event.viewport.zoom) return;
          const tmp_viewState = {
            coordinates: {
              latitude: event.coordinate![1],
              longitude: event.coordinate![0],
            },
            zoom: event.viewport?.zoom,
            viewport: {
              width: event.viewport?.width,
              height: event.viewport?.height,
            },
            visibleArea: calculateVisibleArea(event.coordinate![0], event.viewport?.zoom, event.viewport?.width, event.viewport?.height),
          };
          setViewState(tmp_viewState);
        }}
      >
        <Map
          reuseMaps
          mapStyle={mapStyle}
        />
      </DeckGL>
    </>

  ) : (
    <div>Loading...</div>
  );
}


function App() {
  const [date, setDate] = useState(new Date("2023-01-01T02:00"));
  const [playing, isPlaying] = useState(false);

    useEffect(() => {
        if (playing) {
        const interval = setInterval(() => {
            const newDate = new Date(date);
            newDate.setHours(newDate.getHours() + 1);
            setDate(newDate);
        }, 3000);
        return () => clearInterval(interval);
        }
    }, [playing, date]);

  return (
    <Box display={"flex"} flexDirection={"column"} justifyContent={"center"} alignItems={"center"} width={"100%"}>
      <h2>Concentració de NO2 a les Carreteres Catalanes</h2>
      <Box display={"flex"} alignItems={"center"} mb={2} gap={4}>
        <LocalizationProvider dateAdapter={AdapterDateFns}>
          {/* Selector de fecha */}
          <DatePicker
            label="Fecha a visualizar"
            format={"dd/MM/yyyy"}
            value={date}
            disabled={playing}
            onChange={(newValue) => {
              if (newValue) {
                // Actualiza solo la fecha, manteniendo la hora seleccionada
                const updatedDate = new Date(date);
                updatedDate.setFullYear(newValue.getFullYear());
                updatedDate.setMonth(newValue.getMonth());
                updatedDate.setDate(newValue.getDate());
                setDate(updatedDate);
              }
            }}
            minDate={new Date("2023-01-01")}
            maxDate={new Date("2023-12-31")}
          />

          {/* Selector de hora */}
          <TimePicker
            views={["hours"]}
            label="Hora a visualizar"
            value={date}
            minTime={new Date("2023-01-01T02:00")}
            disabled={playing}
            onChange={(newValue) => {
              if (newValue) {
                // Actualiza solo la hora
                const updatedDate = new Date(date);
                updatedDate.setHours(newValue.getHours());
                setDate(updatedDate);
              }
            }}
          />
        </LocalizationProvider>
        {playing ? (
            <Button variant="contained" size="large" color="error" endIcon={<StopCircleIcon />} onClick={() => isPlaying(false)}>Parar</Button>
          ) : (
            <Button variant="contained" size="large" endIcon={<PlayArrowIcon />} onClick={() => isPlaying(true)}>Reproduir</Button>
          )
        }
      </Box>

      <Box style={{height: '80vh', width: '80vw', position: 'relative'}}>
      <MapVisualizer date={date} playing={playing}/>
    </Box>
</Box>
)
}

export default App
