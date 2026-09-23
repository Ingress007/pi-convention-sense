package com.acme.order.service.impl;

import com.acme.order.error.BizException;
import com.acme.order.error.OrderErrorCode;
import com.acme.order.mapper.OrderMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
public class OrderServiceImpl implements OrderService {
    private final OrderMapper orderMapper;

    public OrderServiceImpl(OrderMapper orderMapper) {
        this.orderMapper = orderMapper;
    }

    @Transactional
    public OrderResponse create(OrderRequest request) {
        log.info("creating order {}", request.getId());
        if (request == null) {
            throw new BizException(OrderErrorCode.INVALID_REQUEST);
        }
        return orderMapper.toResponse(request);
    }
}
