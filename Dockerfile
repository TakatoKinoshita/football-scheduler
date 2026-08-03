FROM public.ecr.aws/lambda/python:3.14 AS build

WORKDIR /build

COPY requirements-lambda.txt ./

# Install only dependency versions and artifacts recorded in uv.lock. The
# exported file includes hashes, so pip fails if an artifact differs.
RUN python -m pip install \
    --disable-pip-version-check \
    --no-cache-dir \
    --only-binary=:all: \
    --require-hashes \
    --target /asset \
    --requirement requirements-lambda.txt

# The application package is pure Python. Copying it directly avoids a second,
# implicit build-backend dependency resolution during the image build.
COPY src/football_scheduler /asset/football_scheduler

FROM public.ecr.aws/lambda/python:3.14

COPY --from=build /asset ${LAMBDA_TASK_ROOT}

CMD ["football_scheduler.lambda_handler.lambda_handler"]
