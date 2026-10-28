import { readFile } from "node:fs/promises";

export type Coordinate = readonly [number, number];
export interface RoadRoute {
  id: string;
  roads: string[];
  points: Coordinate[];
}
export interface Car {
  id: string;
  name: string;
  route: RoadRoute;
  speed: number;
  offset: number;
}

export async function loadCars(): Promise<Car[]> {
  const data = JSON.parse(
    await readFile(new URL("routes.json", import.meta.url), "utf8"),
  );
  return data.routes.map((route: RoadRoute, index: number) => ({
    id: `car-${index + 1}`,
    name: `Car ${index + 1}`,
    route,
    speed: 5 + index * 0.4,
    // Spread the first view across the road network rather than overlapping labels.
    offset: [0, 0.1, 0, 0.4, 0.85, 0.4][index],
  }));
}

export function metres(a: Coordinate, b: Coordinate): number {
  return Math.hypot((b[0] - a[0]) * 111195, (b[1] - a[1]) * 89800);
}

/** Distance along a closed road polyline; laps never reset event identity. */
export function journey(car: Car) {
  const points = car.route.points;
  const lengths = points.slice(1).map((point, i) => metres(points[i], point));
  const length = lengths.reduce((a, b) => a + b, 0);
  if (length <= 0 || metres(points[0], points.at(-1)!) > 1)
    throw new Error(
      `Route ${car.route.id} must be a non-empty closed journey.`,
    );
  return {
    length,
    position(seconds: number): Coordinate {
      let distance = (seconds * car.speed + car.offset * length) % length;
      for (let i = 0; i < lengths.length; i++) {
        if (distance <= lengths[i] && lengths[i] > 0) {
          const fraction = distance / lengths[i];
          return [
            points[i][0] + (points[i + 1][0] - points[i][0]) * fraction,
            points[i][1] + (points[i + 1][1] - points[i][1]) * fraction,
          ];
        }
        distance -= lengths[i];
      }
      return points[0];
    },
  };
}
