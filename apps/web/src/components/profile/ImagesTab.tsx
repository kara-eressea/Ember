// Images tab (COMPONENTS-profile-viewer.md §11, frame P·F): the profile's
// own `images` array — already inside the cached character-data payload,
// so this tab costs zero F-List requests. Thumbs hotlink static.f-list.net
// (like avatars/eicons), lazy-loaded with a fixed aspect box so the grid
// never reflows; a stale cache can list a since-deleted image, which
// degrades to a quiet placeholder. Click → lightbox *within* the modal.

import { useEffect, useState } from "react";
import type { ProfileDto } from "@emberchat/protocol";
import styles from "./profile.module.css";

export function ImagesTab({ profile }: { profile: ProfileDto }) {
  const [lightbox, setLightbox] = useState<number>();
  const images = profile.images;

  if (images.length === 0) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyTile} aria-hidden>
          ▦
        </span>
        <span className={styles.emptyTitle}>No images</span>
        <span className={styles.emptyBody}>
          {profile.name} hasn't uploaded any profile images.
        </span>
      </div>
    );
  }

  return (
    <>
      <div className={styles.imgGrid}>
        {images.map((image, index) => (
          <button
            key={image.id}
            type="button"
            className={styles.imgThumb}
            title={image.description}
            aria-label={`Image ${String(index + 1)} of ${String(images.length)}`}
            onClick={() => {
              setLightbox(index);
            }}
          >
            <Thumb
              src={image.url}
              alt={image.description || `Image ${String(index + 1)}`}
            />
            <span className={styles.imgCaption}>
              {index + 1}/{images.length}
            </span>
          </button>
        ))}
      </div>
      {lightbox !== undefined && images[lightbox] && (
        <Lightbox
          images={images}
          index={lightbox}
          onNavigate={setLightbox}
          onClose={() => {
            setLightbox(undefined);
          }}
        />
      )}
    </>
  );
}

/** A grid thumb that degrades to a placeholder when the upstream image is
 * gone (stale cache) instead of a broken-image glyph. */
function Thumb({ src, alt }: { src: string; alt: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span className={styles.imgBroken} aria-hidden>
        ∅
      </span>
    );
  }
  return (
    <img
      className={styles.imgThumbImg}
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => {
        setBroken(true);
      }}
    />
  );
}

function Lightbox({
  images,
  index,
  onNavigate,
  onClose,
}: {
  images: ProfileDto["images"];
  index: number;
  onNavigate: (index: number) => void;
  onClose: () => void;
}) {
  const image = images[index];
  const [zoomed, setZoomed] = useState(false);
  // Each image opens fit-to-box, so reset zoom on every navigation.
  const previous = () => {
    setZoomed(false);
    onNavigate((index - 1 + images.length) % images.length);
  };
  const next = () => {
    setZoomed(false);
    onNavigate((index + 1) % images.length);
  };

  // Capture-phase keys with stopPropagation so Escape closes the lightbox,
  // not the profile modal underneath (both listen on window).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      } else if (event.key === "ArrowLeft") {
        previous();
      } else if (event.key === "ArrowRight") {
        next();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  });

  if (!image) {
    return null;
  }
  return (
    <div
      className={styles.lightbox}
      role="dialog"
      aria-label={`Image ${String(index + 1)} of ${String(images.length)}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <img
        className={`${styles.lightboxImg} ${
          zoomed ? styles.lightboxImgZoomed : ""
        }`}
        src={image.url}
        alt={image.description || `Image ${String(index + 1)}`}
        aria-label={zoomed ? "Zoom out" : "Zoom in"}
        onClick={(event) => {
          // Toggle zoom without bubbling to the backdrop (which closes).
          event.stopPropagation();
          setZoomed((value) => !value);
        }}
      />
      {image.description !== "" && (
        <span className={styles.lightboxDesc}>{image.description}</span>
      )}
      <div className={styles.lightboxBar}>
        <button
          type="button"
          className={styles.iconBtn}
          aria-label="Previous image"
          onClick={previous}
        >
          ‹
        </button>
        <span className={styles.lightboxCounter}>
          {index + 1}/{images.length}
        </span>
        <button
          type="button"
          className={styles.iconBtn}
          aria-label="Next image"
          onClick={next}
        >
          ›
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          aria-label="Close image"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
