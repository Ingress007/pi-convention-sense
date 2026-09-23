package com.acme.order.service.impl;

import com.acme.order.error.BizException;
import com.acme.order.error.OrderErrorCode;
import com.acme.order.mapper.RefundMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
public class RefundServiceImpl implements RefundService {
    private final RefundMapper refundMapper;

    public RefundServiceImpl(RefundMapper refundMapper) {
        this.refundMapper = refundMapper;
    }

    @Transactional
    public RefundResponse create(RefundRequest request) {
        log.info("creating refund {}", request.getId());
        if (request == null) {
            throw new BizException(OrderErrorCode.INVALID_REQUEST);
        }
        return refundMapper.toResponse(request);
    }
}
