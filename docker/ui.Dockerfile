FROM python:3.12-slim

WORKDIR /app

COPY ui/ /app/ui/

EXPOSE 9400

CMD ["python", "ui/server.py"]
