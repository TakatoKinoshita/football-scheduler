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

# Fail the image build if package-resource lookup, catalog digests, or coverage
# differ from the runtime contract.
RUN PYTHONPATH=/asset python -c \
    "from football_scheduler.placement_template_runtime import load_placement_template_catalog; assert len(load_placement_template_catalog().entries_by_id) == 160"

# Git does not preserve read bits, and a restrictive checkout umask may leave
# copied sources unreadable by Lambda's least-privileged runtime user.
RUN chmod -R a+rX /asset

FROM public.ecr.aws/lambda/python:3.14

COPY --from=build /asset ${LAMBDA_TASK_ROOT}

CMD ["football_scheduler.lambda_handler.lambda_handler"]
