CREATE TABLE IF NOT EXISTS match_sessions (
  id            VARCHAR(36)  PRIMARY KEY,
  user_id       INT          NOT NULL,
  video_s3_key  VARCHAR(512) DEFAULT NULL,
  matched_tracks JSON        NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_sessions (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
