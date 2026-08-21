export type RequestGate = {
  begin: () => number;
  current: (generation: number) => boolean;
  invalidate: () => void;
};

export const createRequestGate = (): RequestGate => {
  let generation = 0;
  return {
    begin: () => ++generation,
    current: (candidate) => candidate === generation,
    invalidate: () => {
      generation += 1;
    },
  };
};
