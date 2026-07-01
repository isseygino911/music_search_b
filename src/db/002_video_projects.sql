CREATE TABLE IF NOT EXISTS video_projects (
  id               VARCHAR(36)  PRIMARY KEY,
  user_id          INT          NOT NULL,
  track_id         INT          NOT NULL,
  video_s3_key     VARCHAR(512) NOT NULL,
  output_s3_key    VARCHAR(512) DEFAULT NULL,
  video_start      FLOAT        NOT NULL DEFAULT 0,
  video_end        FLOAT        DEFAULT NULL,
  audio_start      FLOAT        NOT NULL DEFAULT 0,
  audio_end        FLOAT        DEFAULT NULL,
  status           ENUM('draft','rendering','done','error') NOT NULL DEFAULT 'draft',
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_projects (user_id, created_at),
  INDEX idx_track (track_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
