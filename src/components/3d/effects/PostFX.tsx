/**
 * POST-PROCESSING STACK
 * =====================
 * Bloom + vignette. The Bloom luminance threshold is 1.0, so ONLY HDR
 * emitters (exhaust core colors > 1.0, glowing engine bells, separation
 * rings) bloom — regular scene whites stay crisp.
 *
 * PERFORMANCE KNOB: if the sim ever drops frames alongside the dashboard,
 * removing <PostFX/> from the Canvas is the single cheapest fix — everything
 * else in the scene works without it (plumes just lose their glow halo).
 */

import React from "react";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";

export const PostFX: React.FC = () => (
  <EffectComposer multisampling={0}>
    <Bloom mipmapBlur intensity={0.45} luminanceThreshold={1.0} luminanceSmoothing={0.25} />
    <Vignette darkness={0.35} eskil={false} />
  </EffectComposer>
);
