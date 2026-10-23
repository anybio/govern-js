export interface GenerateTarget {
  spec: string;
  out: string;
  banner: string;
}
export const TARGETS: GenerateTarget[];
export function generateTypes(specJson: string, target: Pick<GenerateTarget, "banner">): Promise<string>;
