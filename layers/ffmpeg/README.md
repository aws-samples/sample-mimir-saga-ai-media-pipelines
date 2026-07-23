# FFmpeg Lambda Layer

Static FFmpeg build for use in Lambda functions that need FFmpeg/FFprobe.

## Setup

Download the static build and place binaries in `bin/`:

```bash
wget https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar -xf ffmpeg-release-amd64-static.tar.xz
cp ffmpeg-*-amd64-static/ffmpeg layers/ffmpeg/bin/
cp ffmpeg-*-amd64-static/ffprobe layers/ffmpeg/bin/
chmod +x layers/ffmpeg/bin/ffmpeg layers/ffmpeg/bin/ffprobe
```

## Usage in Lambda

Binaries are available at `/opt/bin/ffmpeg` and `/opt/bin/ffprobe`.

Set `FFMPEG_PATH=/opt/bin/ffmpeg` in Lambda environment variables.
