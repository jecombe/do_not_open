import { SpotLight, Vector3 } from "three";
import { buildBoxSpec } from "@dno/generator";
import { BOX_SIZE, BoxShaker, createBox } from "@dno/scene";
import { PALETTE, Stage } from "./stage";

/** The sealed box, turning slowly under the dock lamp. Click it and it rattles. */
export class HeroScene {
  private readonly stage: Stage;

  constructor(host: HTMLElement, tokenId: number) {
    const stage = (this.stage = new Stage(host));
    stage.addGround(1.45, 1.45, 0);
    const box = createBox(buildBoxSpec(tokenId));
    box.group.userData.pick = "box";
    stage.scene.add(box.group);
    stage.pickables.push(box.group);

    const lamp = new SpotLight(PALETTE.sodium, 40, 9, 0.55, 0.7, 1.5);
    lamp.position.set(0.8, 4.2, 1.6);
    lamp.target.position.set(0, BOX_SIZE.height / 2, 0);
    stage.scene.add(lamp, lamp.target);

    const shaker = new BoxShaker(box, { reducedMotion: stage.reduced });
    stage.onSelect = () => {
      shaker.shake();
      stage.wake();
    };
    stage.onLayout = () => stage.frame(new Vector3(0, BOX_SIZE.height * 0.52, 0), 2.5, 2.1, new Vector3(0.55, 0.62, 1));
    stage.onLayout(1);
    box.group.rotation.y = -0.5;
    stage.onFrame((_time, dt) => {
      if (!stage.reduced) box.group.rotation.y += dt * 0.22;
      shaker.update(dt);
    });
  }

  dispose(): void {
    this.stage.dispose();
  }
}
