/** Exact unit-cost GCRA inputs; enforcement must not round periodSeconds / rate. */
export type GcraPolicyConfig = Readonly<{
  burst: number;
  rate: number;
  periodSeconds: number;
}>;
