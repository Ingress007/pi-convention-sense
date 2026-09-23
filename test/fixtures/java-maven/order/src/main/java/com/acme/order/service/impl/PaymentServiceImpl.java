package com.acme.order.service.impl;

import com.acme.order.error.BizException;
import com.acme.order.error.OrderErrorCode;
import com.acme.order.mapper.PaymentMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
public class PaymentServiceImpl implements PaymentService {
    private final PaymentMapper paymentMapper;

    public PaymentServiceImpl(PaymentMapper paymentMapper) {
        this.paymentMapper = paymentMapper;
    }

    @Transactional
    public PaymentResponse create(PaymentRequest request) {
        log.info("creating payment {}", request.getId());
        if (request == null) {
            throw new BizException(OrderErrorCode.INVALID_REQUEST);
        }
        return paymentMapper.toResponse(request);
    }
}
