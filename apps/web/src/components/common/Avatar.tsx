// Character avatar: real F-List profile image with the designed
// initial-on-color fallback as the loading/error state (decisions.md §6).

import { useState } from "react";
import { avatarUrl, nameInitial } from "../../lib/avatar.js";
import { nickColor } from "../../theme/tokens.js";
import styles from "./avatar.module.css";

export interface AvatarProps {
  name: string;
  /** Box size in px; radius and dot specs follow COMPONENTS.md. */
  size: number;
  /** Rounded square (active identity) instead of a circle. */
  square?: boolean;
}

export function Avatar({ name, size, square = false }: AvatarProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = avatarUrl(name);
  const showImage = url !== undefined && !failed;

  return (
    <span
      className={styles.avatar}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.45),
        borderRadius: square ? "11px" : "50%",
        backgroundColor: nickColor(name),
      }}
      aria-hidden="true"
    >
      {!(showImage && loaded) && nameInitial(name)}
      {showImage && (
        <img
          className={styles.image}
          src={url}
          alt=""
          loading="lazy"
          width={size}
          height={size}
          style={{ opacity: loaded ? 1 : 0 }}
          onLoad={() => {
            setLoaded(true);
          }}
          onError={() => {
            setFailed(true);
          }}
        />
      )}
    </span>
  );
}
